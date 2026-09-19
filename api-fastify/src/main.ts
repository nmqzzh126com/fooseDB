import fastify from "fastify";
import fastifyStatic from "@fastify/static"; //加入静态页面插件
import autoload from "@fastify/autoload";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import path from "node:path";
import fs from "node:fs";
import {
  registerAll,
  getAllStatuses,
  closeAll,
  bulkRegisterObjectDsFromDb
} from "./datasources/registry.js";
import { registerAllCaches, getAllCacheStatuses, closeAllCaches } from "./caches/registry.js";
import { getCacheDecls } from "./config/caches.js";
import { getAdminPath } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { purgeExpiredRefreshTokens } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// —— 加载 FoosDB 的 .env 到 process.env（零额外依赖的最小实现）——
{
  const envPath = resolveFromDir(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      let v = s
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      // 不覆盖已通过命令行 export/NODE_ENV 设置的值
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

function resolveFromDir(from: string, p: string) {
  // .env 放在 api-fastify/ 目录（与 src/、dist/ 同级），所以需要从 src/ 或 dist/ 往上一级
  return path.join(from, "..", p);
}
// 前端构建产物目录：两级优先级，做到「开发走兄弟项目 + 打包后自包含」
//   优先级 1（生产打包后自包含）：
//     __dirname/public
//     dev  ：api-fastify/src/public   → 通常不存在
//     prod ：api-fastify/dist/public  → build 脚本从 admin-vue/dist 拷入
//     这样部署到服务器只需 api-fastify 一个子项目的 dist+node_modules+.env+data，
//     完全不依赖 admin-vue 源目录与构建结果。
//   优先级 2（开发/联调兜底）：
//     __dirname/../../admin-vue/dist  → monorepo 兄弟目录
//   兜底（极旧遗留）：
//     __dirname/../src/public
let pureAdmin: string;
const embeddedPublic = path.join(__dirname, "public");
const siblingDist = path.join(__dirname, "..", "..", "admin-vue", "dist");
const legacySrc = path.join(__dirname, "..", "src", "public");
if (fs.existsSync(embeddedPublic)) {
  pureAdmin = embeddedPublic;
  console.log("static page (embedded in dist):", pureAdmin);
} else if (fs.existsSync(siblingDist)) {
  pureAdmin = siblingDist;
  console.log("static page (sibling admin-vue/dist):", pureAdmin);
} else {
  pureAdmin = legacySrc;
  console.log("static page (fallback src/public):", pureAdmin);
}

const app = fastify({ logger: true });
// 加入 admin-vue 的静态资源,用于后台管理
app.register(fastifyStatic, {
  root: pureAdmin,
  prefix: "/" // 改为根前缀，使 index.html 中的 /static/*、/favicon.ico 等绝对路径能正确命中
});

// —— 数据源必须在「路由/插件注册」之前初始化：
//    1. registerAll() — 注册内置 sqlite_app（配置库 app.db）
//    2. bulkRegisterObjectDsFromDb() — 扫描 object 表，为每行注册数据源
await registerAll();
await bulkRegisterObjectDsFromDb();
console.log(
  "datasource init statuses:",
  getAllStatuses()
    .map(s => `${s.name}/${s.type}:${s.status}`)
    .join(", ")
);

// —— 缓存在 datasources 之后、routes 之前初始化（与 datasources 完全对称）：
//    未声明任何 REDIS_* 时 registry 只打 WARN 不抛错；声明了但 Redis 服务离线会单条降级为 Stub。
console.log(
  "cache decls:",
  getCacheDecls()
    .map(c => `${c.name}:${c.type}${c.enabled ? "+enabled" : "(stub)"}`)
    .join(", ") || "<空，Redis 功能未启用>"
);
const cacheSummary = await registerAllCaches();
console.log(
  "cache init statuses:",
  getAllCacheStatuses()
    .map(s => `${s.name}/${s.type}:${s.status}${s.enabled ? "" : "(disabled)"}`)
    .join(", ") || "<无>"
);

// —— Redis 未启用 / 未连接 → 输出显眼的黄色横幅警告 ——
// 规则：
//   a) .env 里压根一条 REDIS_* 都没写（summary.neverDeclared=true）→ 提示"建议装 Redis + 最小 .env 配置"
//   b) 有声明但 open() 失败（summary.openFailedNames 非空）→ 提示"Redis 没启动 / URL 配错 + 启动命令"
//   c) 有声明但 ENABLED=false 导致 Stub（summary.stubNames 减去主动 openFailed 的）→ 提示"把 __ENABLED=true"
// 颜色使用 ANSI 33m 黄色 + 1m 粗体，Windows PowerShell / Windows Terminal / Git Bash / iTerm2 都原生支持，
// 不支持 ANSI 的旧 cmd 会退化为普通文本（至少内容是可读的，不会让用户一头雾水）。
{
  const s = cacheSummary;
  if (s.neverDeclared || s.stubNames.length > 0) {
    const Y = "\x1b[33m"; // 黄色
    const B = "\x1b[1m"; // 粗体
    const R = "\x1b[0m"; // 重置

    const lines: string[] = [];
    lines.push(`${Y}${B}╔══════════════════════════════════════════════════════════════╗${R}`);
    lines.push(`${Y}${B}║          ⚠  建议安装并启动 Redis                             ║${R}`);
    lines.push(`${Y}${B}╚══════════════════════════════════════════════════════════════╝${R}`);
    if (s.neverDeclared) {
      lines.push(
        `${Y}· 原因：.env 中未检测到任何 REDIS_* 声明，缓存层已整体跳过（Stub 模式）。${R}`
      );
      lines.push(
        `${Y}  （Stub 模式下：cache.get 永远 null / cache.set 是 noop / 登录限流 P1 完全关闭）${R}`
      );
      lines.push("");
      lines.push(`${Y}— 步骤 1：安装 Redis —${R}`);
      lines.push(
        `${Y}   Windows  (WSL) : wsl -d Ubuntu -- sudo apt-get install -y redis-server && wsl -d Ubuntu -- sudo service redis-server start${R}`
      );
      lines.push(
        `${Y}   Windows  (原生)  : 安装 Memurai  免费版（https://www.memurai.com/）或 Chocolatey: choco install redis-64 -y${R}`
      );
      lines.push(`${Y}   macOS            : brew install redis && brew services start redis${R}`);
      lines.push(
        `${Y}   Linux  (deb)     : sudo apt-get install -y redis-server && sudo systemctl enable --now redis-server${R}`
      );
      lines.push(
        `${Y}   Docker  (最简)   : docker run -d --name pure-redis -p 6379:6379 --restart unless-stopped redis:7-alpine${R}`
      );
      lines.push("");
      lines.push(`${Y}— 步骤 2：.env 追加最小配置（启用主缓存 + 登录限流缓存）—${R}`);
      lines.push(`${Y}   REDIS_CACHE_DEFAULT__ENABLED=true${R}`);
      lines.push(`${Y}   REDIS_CACHE_DEFAULT__URL=redis://127.0.0.1:6379${R}`);
      lines.push(`${Y}   REDIS_CACHE_RATELIMIT__ENABLED=true${R}`);
      lines.push(`${Y}   REDIS_CACHE_RATELIMIT__URL=redis://127.0.0.1:6379${R}`);
    } else {
      // 有声明但实际 Stub：区分"主动没启用" vs "open 失败"
      const activeFails = s.openFailedNames;
      const disabledByCfg = s.stubNames.filter(n => !activeFails.includes(n));
      if (activeFails.length > 0) {
        lines.push(
          `${Y}· 原因：以下缓存声明了 ENABLED=true，但连接 Redis 失败 → 降级为 Stub：${activeFails.join(", ")}${R}`
        );
        lines.push(
          `${Y}  常见：Redis 服务未启动 / __URL 主机端口不对 / 需要密码。先确认本机能 ping 通：${R}`
        );
        lines.push(
          `${Y}      Windows: redis-cli.exe -h 127.0.0.1 -p 6379 ping     → 正常返回 PONG${R}`
        );
        lines.push(`${Y}      *nix   : redis-cli -h 127.0.0.1 -p 6379 ping${R}`);
        lines.push(`${Y}      启动命令（常见）:${R}`);
        lines.push(
          `${Y}        · Docker:   docker start pure-redis   (若没有先跑 docker run -d -p 6379:6379 redis:7-alpine --name pure-redis)${R}`
        );
        lines.push(`${Y}        · WSL/Ubuntu: sudo service redis-server start${R}`);
        lines.push(`${Y}        · macOS:      brew services start redis${R}`);
      }
      if (disabledByCfg.length > 0) {
        lines.push(
          `${Y}· 注意：以下缓存已在 .env 声明，但 __ENABLED 未设为 true（Stub 占位，不连接，不缓存）：${disabledByCfg.join(", ")}${R}`
        );
        lines.push(`${Y}  修复：将对应行的 REDIS_<NAME>__ENABLED=true 写入 .env 后重启即可。${R}`);
      }
    }
    lines.push("");
    lines.push(`${Y}功能影响 (Stub 模式下，功能依然可用但会退化)：${R}`);
    lines.push(
      `${Y}  · P1 登录限流：关闭，登录接口不会拒绝暴力尝试（P0 密码哈希 + P2 客户端指纹仍生效）${R}`
    );
    lines.push(
      `${Y}  · 业务缓存：每个 cache.get() 都 miss，所有查询直接回数据库；cache.set() 不生效${R}`
    );
    lines.push(`${Y}  · 分布式锁 / Session 共享缓存：依赖真实 Redis 的高级功能将不会命中${R}`);
    lines.push(
      `${Y}${B}┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${R}`
    );
    console.warn(lines.join("\n"));
  }
}

// 注意：以下 register 必须在 registerAll() 之后（routes 下任何模块的首次请求会调 service 层 getDs(name)，
//    getDs 依赖 registry 已初始化好；plugins 无 DB 依赖，位置无碍）。
//    dirNameRoutePrefix=false：禁用「把 routes/ 的子目录名当成 URL 前缀」的默认行为——
//    因为我们在每个路由文件内都写了完整显式路径（如 /api/users、/admin、/health），
//    不希望 routes/v1/users.ts 被自动挂成 /v1/api/users。
await app.register(autoload, { dir: join(__dirname, "plugins") });
await app.register(autoload, {
  dir: join(__dirname, "routes"),
  // ★关键勿删，dirNameRoutePrefix: false;---> 禁用「子目录名=URL 前缀」
  // 每个路由文件里显式写的 /api/users / /admin 才是真路径。
  //
  // 自定义 SQL 功能由两个路由文件共同组成，均通过此 autoload 加载：
  //   · routes/config/query-templates.ts → 管理端 CRUD（/api/config/query-templates）
  //        管理接口在 object / query_template 管理路由之后加载，但因 autoload
  //        按字母序扫描，custom-query 管理会先于 v1 执行；无互相依赖，顺序不影响。
  //        注意：RESERVED_OBJECT_NAMES=["config","auth","users","custom"] 用来阻止
  //        用户把 object 项目名设置成 "custom"（否则与下条路由 URL 冲突）。
  //   · routes/v1/custom.ts          → 执行端（POST /api/custom/:name）
  //        通过 object_id JOIN 查 app.db 后，决定走哪个 datasource 执行，并继承
  //        object.auth_required + query_template.role_required 的鉴权策略；
  //        object.custom_sql_enabled=0（默认关闭）时该路由仍注册，调用才返回 503。
  dirNameRoutePrefix: false
});

const port = Number(process.env.PORT ?? 8858);
// 监听地址：默认 0.0.0.0（所有网卡）；仅本机访问可在 .env 设 HOST=127.0.0.1
const host = (process.env.HOST ?? "0.0.0.0").trim() || "0.0.0.0";

// —— 优雅停机：SIGINT/SIGTERM 时先关 fastify → 再关 caches → 再关 datasources（倒序生命周期）——
const shutDown = async (sig: string) => {
  logger.info("main", `收到 ${sig}，开始优雅停机...`);
  try {
    await app.close();
  } catch (e) {
    logger.error("main", "fastify close failed:", e);
  }
  try {
    await closeAllCaches();
  } catch (e) {
    logger.error("main", "caches close failed:", e);
  }
  try {
    await closeAll();
  } catch (e) {
    logger.error("main", "datasources close failed:", e);
  }
  logger.info("main", "server stopped.");
  process.exit(0);
};
process.on("SIGINT", () => {
  void shutDown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutDown("SIGTERM");
});

await app.listen({ host, port });
console.log(`API listening http://${host}:${port}`);
const admin = getAdminPath();
console.log(`Admin panel: http://${host}:${port}${admin}`);

// —— 周期性清理已过期的 refresh_tokens（启动时 initDb 已清过一次）——
//   间隔由 .env REFRESH_TOKEN_PURGE_INTERVAL_HOURS 控制：默认 24 小时；
//   设 0 = 停用定时清理（启动时的一次性清理仍执行，过期行不会无限堆积到影响安全）。
//   非法值（负数/小数/非数字）回退默认 24。用 .unref() 让定时器不阻止进程退出。
function parsePurgeHours(raw: string | undefined): number {
  if (raw == null) return 24;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) return 24;
  return n;
}
const purgeHours = parsePurgeHours(process.env.REFRESH_TOKEN_PURGE_INTERVAL_HOURS);
if (purgeHours > 0) {
  const purgeTimer = setInterval(
    () => {
      try {
        const removed = purgeExpiredRefreshTokens();
        if (removed > 0)
          logger.info("main", `purgeExpiredRefreshTokens: removed ${removed} expired row(s)`);
      } catch (e) {
        logger.error("main", "purgeExpiredRefreshTokens failed:", e);
      }
    },
    purgeHours * 60 * 60 * 1000
  );
  purgeTimer.unref?.();
} else {
  logger.info(
    "main",
    "refresh_tokens 定时清理已停用（REFRESH_TOKEN_PURGE_INTERVAL_HOURS=0），启动清理仍执行。"
  );
}
