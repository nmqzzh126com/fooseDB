import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, resolve, isAbsolute } from "node:path";
import fs from "node:fs";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 配置库（app.db）路径。
 *
 * 优先级：
 *   1. APP_DB_PATH_FOR_TESTS  —— 测试专用覆盖（test/setup-env.ts 在所有 src 模块之前
 *      import，把它指向 os.tmpdir() 下的临时文件）。生产 .env **不应**设置此变量。
 *   2. 默认硬编码              —— FoosDB/data/app.db（物理目录 api-fastify/data，__dirname 往上一级）。
 *
 * 目录不存在时自动 mkdirSync。返回绝对路径。
 */
export function getDbPath(): string {
  const override = process.env.APP_DB_PATH_FOR_TESTS?.trim();
  const abs = override ? resolve(override) : resolve(__dirname, "..", "data", "app.db");
  const dir = resolve(abs, "..");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return abs;
}

let _db: Database.Database | null = null;

/** 返回 SQLite 连接单例。首次调用时初始化 WAL、外键等关键 pragma。 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const path = getDbPath();
  console.log("[db] opening:", path);

  _db = new Database(path);

  const wal = _db.pragma("journal_mode = WAL", { simple: true });
  console.log("[db] journal_mode:", wal);
  _db.pragma("synchronous = NORMAL");
  _db.pragma("busy_timeout = 5000");
  _db.pragma("foreign_keys = ON");

  return _db;
}

/** 关闭连接 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** 判断密码是否 bcrypt 哈希（$2a$10$...） */
function isBcryptHash(s: string): boolean {
  return s.startsWith("$2");
}

/**
 * bcrypt cost factor（哈希强度）：10 是安全与性能的平衡点（单次哈希约 60~100ms）。
 * 可用 .env BCRYPT_COST 覆盖（仅接受 4~31 的整数）；缺省/非法回退 10。
 * 种子用户、明文密码迁移、运行时改密（auth.service.hashPassword）全部共用此值，
 * 避免不同入口哈希强度不一致。
 */
function parseBcryptCost(raw: string | undefined): number {
  if (raw == null) return 10;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < 4 || n > 31) return 10;
  return n;
}
export const BCRYPT_COST = parseBcryptCost(process.env.BCRYPT_COST);

/**
 * 初始化表结构 + 种子数据 + 明文密码迁移。
 * 改为 async 以支持 bcrypt.hash（密码哈希是 CPU 密集，必须异步）。
 *
 * @param db 可选：外部传入的 Database 实例（SqliteDataSource 打开的独立连接）；
 *           不传则使用全局单例 getDb()。
 */
export async function initDb(db?: Database.Database): Promise<void> {
  const d = db ?? getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      nickname      TEXT,
      password      TEXT NOT NULL,
      -- token_version: 签发 token 的「代次」。改密 / 强制注销时自增；
      --   verifyToken 比对 payload.tv ≠ users.token_version → 立即 401，不必等 2h 过期。
      --   默认 1。短进程内缓存 token_version 降低 SQLite 读压力（10s TTL）。
      token_version INTEGER NOT NULL DEFAULT 1,
      -- object_id: 当前用户允许访问的 object（项目）ID。
      --   = -1 表示系统管理员（supervisor / sysadmin），可以访问任意 object 下
      --     的所有接口、管理端 /api/config/*、/api/users 用户管理、模板管理等。
      --   >= 1 表示仅绑定到某一个 object 项目：
      --     · 通用接口 /api/:object/:table — 仅当 :object 的 id 与用户 object_id 匹配时放行，否则 403。
      --     · object_table 未声明的表不允许访问（白名单模式）。
      --     · 自定义 SQL POST /api/custom/:name — 仅当模板绑定的 object_id 等于用户 object_id，或用户 object_id=-1 放行。
      --     · /api/config/* 管理端写接口 /api/users（除 GET /me）仅 object_id=-1 允许。
      --   = 0  表示「未配置项目」：新建用户尚未分配项目。用户名密码校验通过（登录成功）后，
      --     服务端返回 403「用户未配置项目信息」，提示联系管理员分配项目；不签发任何 token。
      --  NOT NULL DEFAULT -1 是为了兼容旧数据：历史用户默认是系统管理员。
      object_id     INTEGER NOT NULL DEFAULT -1,
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      -- 2026-09 新增扩展字段
      extended      TEXT,            -- 扩展字段（JSON，任意自定义用户数据）
      avatar        TEXT,            -- 头像 URL
      permissions   TEXT,            -- 权限列表（JSON 或逗号分隔）
      email         TEXT,            -- 邮箱
      phone         TEXT,            -- 手机号
      flag          INTEGER NOT NULL DEFAULT 0  -- 业务标记位（0=正常，非0=自定义语义）
    );

    -- username 唯一约束（列级 UNIQUE 已建 autoindex，此处显式索引给旧库升级补约束，幂等）
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

    -- 角色表（2026-09-18 从 users.roles 列剥离出来）
    CREATE TABLE IF NOT EXISTS roles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      role_name  TEXT NOT NULL,
      flag       INTEGER NOT NULL DEFAULT 0  -- 0=启用, 1=禁用
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name ON roles(role_name);

    -- 用户-角色多对多绑定表
    CREATE TABLE IF NOT EXISTS role_user (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id    INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(role_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_role_user_user ON role_user(user_id);
    CREATE INDEX IF NOT EXISTS idx_role_user_role ON role_user(role_id);

    CREATE TABLE IF NOT EXISTS posts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      title      TEXT NOT NULL,
      content    TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);

    -- ================================================
    -- 元数据配置表（app.db 固定作为所有接口的配置库）
    -- ================================================

    -- object：项目定义。每行自带完整数据库连接配置 + CORS 策略 + 自定义SQL开关
    CREATE TABLE IF NOT EXISTS object (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT UNIQUE NOT NULL,              -- 项目名称（即通用接口 URL 中的 /api/:name/:table）
      description         TEXT,                              -- 项目描述
      db_type             TEXT NOT NULL DEFAULT 'sqlite',    -- 数据库类型：sqlite | mysql | postgres
      db_url              TEXT,                               -- MySQL/PG 连接串（sqlite 时为 NULL）
      db_path             TEXT,                               -- SQLite 文件路径（mysql/pg 时为 NULL）
      cors_origins        TEXT,                               -- CORS 允许的 Origin（逗号分隔或 *；NULL=不设 CORS）
      cors_methods        TEXT,                               -- CORS 允许的方法（逗号分隔；NULL=全部方法）
      custom_sql_enabled  INTEGER NOT NULL DEFAULT 0,         -- 是否允许自定义 SQL（0=关闭 1=开启）
      auth_required       INTEGER NOT NULL DEFAULT 0,        -- 调用接口是否先进行 auth 认证（0=默认不开启 1=开启）
      enabled             INTEGER NOT NULL DEFAULT 1,         -- 项目启用/禁用（0=禁用，拒绝所有请求；1=启用）
      debug               INTEGER NOT NULL DEFAULT 0,         -- 是否开启接口调试日志（0=关闭 1=开启；开启后接口请求/响应记录到 Redis）
      created_at          INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

    -- object.name 唯一约束（列级 UNIQUE 已建 autoindex，此处显式索引给旧库升级补约束，幂等）
    CREATE UNIQUE INDEX IF NOT EXISTS idx_object_name ON object(name);

    -- object_table：表级操作限制。每行针对某项目下某张表
    CREATE TABLE IF NOT EXISTS object_table (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id    INTEGER NOT NULL REFERENCES object(id) ON DELETE CASCADE,
      table_name   TEXT NOT NULL,                      -- 受限的表名
      blocked      INTEGER NOT NULL DEFAULT 0,         -- 1 = 禁止访问该表的所有操作
      allow_select INTEGER NOT NULL DEFAULT 1,         -- 0 = 禁止查询
      allow_insert INTEGER NOT NULL DEFAULT 1,         -- 0 = 禁止单条添加
      allow_update INTEGER NOT NULL DEFAULT 1,         -- 0 = 禁止单条更新
      allow_delete INTEGER NOT NULL DEFAULT 1,         -- 0 = 禁止单条删除
      allow_batch_insert INTEGER NOT NULL DEFAULT 1,   -- 0 = 禁止批量创建
      allow_batch_update INTEGER NOT NULL DEFAULT 1,    -- 0 = 禁止批量更新
      allow_batch_delete INTEGER NOT NULL DEFAULT 1,   -- 0 = 禁止批量删除（ids + filter）
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      UNIQUE(object_id, table_name)
    );

    CREATE INDEX IF NOT EXISTS idx_object_table_obj ON object_table(object_id);

    -- query_template：自定义 SQL 模板。模板只能是 SELECT，运行时以 :name 传参，强制参数化。
    -- 护栏：object.custom_sql_enabled 项目级开关 / SELECT-only / 只读连接 / 超时 & LIMIT 封顶 / 表黑名单 / auth_required / role_required。
    CREATE TABLE IF NOT EXISTS query_template (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id      INTEGER NOT NULL REFERENCES object(id) ON DELETE CASCADE,  -- 绑定项目（决定使用哪个 datasource + 是否继承 auth_required）
      name           TEXT UNIQUE NOT NULL,                   -- 调用名：POST /api/custom/:name
      description    TEXT,                                   -- 模板说明
      sql_text       TEXT NOT NULL,                          -- SQL 本体；只能 SELECT；参数用 :param_name 或 ? 占位
      params_schema  TEXT,                                   -- JSON：{ "name": {"type":"string","required":true,"default":null,"desc":"用户ID"} }，为空时运行时从 sql 抽取占位符自动声明
      role_required  TEXT NOT NULL DEFAULT 'public',         -- public / user / admin；public=任何人（仍受 object.auth_required 限制），user=需登录 user 角色，admin=需登录 admin 角色
      rows_limit     INTEGER NOT NULL DEFAULT 1000,          -- 返回行数自动封顶（额外套一层 LIMIT，防止没写 LIMIT）
      timeout_ms     INTEGER NOT NULL DEFAULT 3000,          -- 执行超时毫秒
      enabled        INTEGER NOT NULL DEFAULT 1,             -- 可单独禁用某个模板
      created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS idx_tpl_obj ON query_template(object_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tpl_name ON query_template(name);

    -- custom_query_log：自定义 SQL 执行审计日志
    CREATE TABLE IF NOT EXISTS custom_query_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id  INTEGER NOT NULL REFERENCES query_template(id) ON DELETE CASCADE,
      caller_user  INTEGER,                                    -- 调用用户 id（匿名为 NULL）
      caller_ip    TEXT,                                       -- 来源 IP（脱敏后存储，直接 X-Forwarded-For / raw IP）
      params_json  TEXT,                                       -- 实际传参 JSON（脱敏：password / secret 等字段自动打 ***）
      row_count    INTEGER,                                    -- 返回行数
      duration_ms  INTEGER NOT NULL DEFAULT 0,                -- 耗时
      status_code  INTEGER NOT NULL DEFAULT 200,              -- 200=成功，其它=失败码
      error_msg    TEXT,                                       -- 失败原因（仅前 500 字符）
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS idx_cql_log_tpl ON custom_query_log(template_id);
    CREATE INDEX IF NOT EXISTS idx_cql_log_time ON custom_query_log(created_at);

    -- refresh_tokens：refresh_token 代次轮换表（OAuth2 "token rotation + reuse detection" 模式）。
    --   · 登录 / refresh 成功时写入一行，返回给客户端的 refresh_token = jwt(type=refresh) 本身；
    --   · 同一用户的同一代次（family_id）只会有一条 valid=1 的记录；
    --   · 客户端拿旧 refresh_token 来换 → 视为 refresh 被盗（reuse），整 family 全部作废 → 401 需要重新登录；
    --   · 登出时把该用户本人所有 family 置 valid=0；expired_at 清理可用定时脚本按天扫。
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      ds             TEXT NOT NULL DEFAULT 'app',   -- 所属数据源：app=admin-panel 配置库；其他=业务库名
      fingerprint    TEXT NOT NULL,                 -- 绑定的客户端指纹；换设备必须重新登录
      family_id      TEXT NOT NULL,                 -- 轮换链 id（同一 family 共享，首次登录生成）
      generation     INTEGER NOT NULL DEFAULT 1,    -- 轮换代次：每次 refresh +1
      jwt_id         TEXT UNIQUE NOT NULL,          -- 对应 refresh_token 的 payload.jti，便于精准定位
      valid          INTEGER NOT NULL DEFAULT 1,    -- 1=有效 0=已用/已撤销/被盗作废
      expires_at     INTEGER NOT NULL,              -- 秒时间戳，与 JWT exp 一致
      issued_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      revoked_at     INTEGER,                       -- 撤销时间戳（debug/审计用）
      revoke_reason  TEXT                           -- 用于写 reuse/logout/kicked_admin
    );
    CREATE INDEX IF NOT EXISTS idx_rt_uid  ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_rt_fam  ON refresh_tokens(family_id);
    CREATE INDEX IF NOT EXISTS idx_rt_jti  ON refresh_tokens(jwt_id);
  `);

  // —— migration：refresh_tokens 加 ds 列 + 索引（支持跨数据源业务用户 token）——
  // 必须放在上面巨大 CREATE TABLE exec 之后——旧表没有 ds 列，CREATE INDEX ON ds 会崩
  try {
    d.prepare("SELECT ds FROM refresh_tokens LIMIT 0").get() as unknown;
  } catch {
    d.exec("ALTER TABLE refresh_tokens ADD COLUMN ds TEXT NOT NULL DEFAULT 'app'");
    console.log("[db] upgraded refresh_tokens: added ds column (default 'app')");
  }
  d.exec("CREATE INDEX IF NOT EXISTS idx_rt_ds ON refresh_tokens(ds)");

  // —— 种子数据（仅空表时插入，密码用 bcrypt 哈希）——
  // 先保证升级兼容：老表没有 token_version / object_id 列时补齐（CREATE TABLE IF NOT EXISTS 不会加新列）。
  try {
    d.prepare("SELECT token_version FROM users LIMIT 0").get() as unknown;
  } catch {
    d.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1");
    console.log("[db] upgraded users: added token_version (default 1)");
  }
  try {
    d.prepare("SELECT object_id FROM users LIMIT 0").get() as unknown;
  } catch {
    // 旧数据默认按「系统管理员」补齐（-1），以避免升级后已有账号不能访问管理端
    d.exec("ALTER TABLE users ADD COLUMN object_id INTEGER NOT NULL DEFAULT -1");
    console.log("[db] upgraded users: added object_id (default -1 = system admin)");
  }
  // 2026-09：extended / avatar / permissions / email / phone 五列（扩展字段）
  for (const [col, def] of [
    ["extended", "TEXT"],
    ["avatar", "TEXT"],
    ["permissions", "TEXT"],
    ["email", "TEXT"],
    ["phone", "TEXT"]
  ] as const) {
    try {
      d.prepare(`SELECT ${col} FROM users LIMIT 0`).get() as unknown;
    } catch {
      d.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
      console.log(`[db] upgraded users: added ${col}`);
    }
  }
  // 2026-09-18：roles 列拆分到 role_user + roles 表，删掉旧列
  try {
    const cols = d.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    if (cols.some(c => c.name === "roles")) {
      d.exec("ALTER TABLE users DROP COLUMN roles");
      console.log("[db] upgraded users: dropped roles column (moved to role_user + roles)");
    }
  } catch (e) {
    console.warn("[db] could not drop roles column:", (e as Error).message);
  }
  // flag 列（业务标记位）
  try {
    d.prepare("SELECT flag FROM users LIMIT 0").get() as unknown;
  } catch {
    d.exec("ALTER TABLE users ADD COLUMN flag INTEGER NOT NULL DEFAULT 0");
    console.log("[db] upgraded users: added flag (default 0)");
  }
  const count = (d.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  if (count === 0) {
    // admin 用户的认证走 .env（ADMIN_USERNAME/ADMIN_PASSWORD），
    // 但 refresh_tokens.user_id 有外键约束 REFERENCES users(id)，
    // 所以 users 表里必须有一条 admin 行作为外键锚点（shadow row）。
    // shadow 行密码用不可猜的 bcrypt 哈希，即使有人改了 .env ADMIN_USERNAME，
    // 旧 admin 用户名也无法通过 users 表路径登录（安全兜底）。
    const adminShadowHash = await bcrypt.hash("__admin_shadow_never_login__", BCRYPT_COST);
    const demoHash = await bcrypt.hash("admin123456!@#", BCRYPT_COST);
    d.prepare("INSERT INTO users(username, nickname, password, object_id) VALUES(?,?,?,?)").run(
      "admin",
      "超级管理员(shadow)",
      adminShadowHash,
      -1
    );
    d.prepare("INSERT INTO users(username, nickname, password, object_id) VALUES(?,?,?,?)").run(
      "demo",
      "演示用户",
      demoHash,
      1
    );
    console.log("[db] seeded users: admin(shadow,不可登录) + demo");
  }

  // —— 明文密码迁移（检测到遗留明文时自动重哈希）——
  const allUsers = d.prepare("SELECT id, username, password FROM users").all() as {
    id: number;
    username: string;
    password: string;
  }[];
  let migrated = 0;
  const updateStmt = d.prepare("UPDATE users SET password = ? WHERE id = ?");
  for (const u of allUsers) {
    if (!isBcryptHash(u.password)) {
      const newHash = await bcrypt.hash(u.password, BCRYPT_COST);
      updateStmt.run(newHash, u.id);
      migrated++;
      console.log(`[db] migrated user password: ${u.username} (id=${u.id})`);
    }
  }
  if (migrated > 0) {
    console.log(`[db] password migration done: ${migrated} user(s) re-hashed`);
  }

  // —— object 表迁移：从旧 ds_name 列 → 新 db_type/db_url/db_path/cors_origins/cors_methods/custom_sql_enabled ——
  // 1. 加新列（guard pattern 同 users.token_version 迁移）
  const newCols = [
    ["db_type", "TEXT NOT NULL DEFAULT 'sqlite'"],
    ["db_url", "TEXT"],
    ["db_path", "TEXT"],
    ["cors_origins", "TEXT"],
    ["cors_methods", "TEXT"],
    ["custom_sql_enabled", "INTEGER NOT NULL DEFAULT 0"],
    ["enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["debug", "INTEGER NOT NULL DEFAULT 0"]
  ] as const;
  let needMigration = false;
  for (const [col, typeDef] of newCols) {
    try {
      d.prepare(`SELECT ${col} FROM object LIMIT 0`).get() as unknown;
    } catch {
      d.exec(`ALTER TABLE object ADD COLUMN ${col} ${typeDef}`);
      console.log(`[db] upgraded object: added column ${col}`);
      needMigration = true;
    }
  }

  // 2. 如果刚加的列 + 旧表有 ds_name 列 → 一次性数据迁移
  let hasDsName = false;
  try {
    d.prepare("SELECT ds_name FROM object LIMIT 0").get() as unknown;
    hasDsName = true;
  } catch {
    // ds_name 列不存在（全新安装），跳过迁移
  }
  if (needMigration && hasDsName) {
    // 从 process.env.DS_* 构建 lookup map
    const dsLookup = new Map<
      string,
      { type: string; url?: string; path?: string; corsOrigins?: string; corsMethods?: string }
    >();
    const dsRe = /^DS_([A-Z0-9_]+)__(TYPE|PATH|URL|CORS_ORIGINS|CORS_METHODS)$/i;
    for (const [rawK, rawV] of Object.entries(process.env)) {
      if (!rawK.startsWith("DS_") || rawV === undefined) continue;
      const m = dsRe.exec(rawK);
      if (!m) continue;
      const nameRaw = m[1].toLowerCase();
      const key = m[2].toUpperCase();
      const cur = dsLookup.get(nameRaw) ?? { type: "sqlite" };
      if (key === "TYPE") cur.type = rawV.trim().toLowerCase();
      else if (key === "PATH") cur.path = rawV.trim();
      else if (key === "URL") cur.url = rawV.trim();
      else if (key === "CORS_ORIGINS") cur.corsOrigins = rawV.trim();
      else if (key === "CORS_METHODS") cur.corsMethods = rawV.trim();
      dsLookup.set(nameRaw, cur);
    }
    const globalCustomSql = (process.env.CUSTOM_SQL_ENABLED ?? "false").trim().toLowerCase();
    const customSqlVal =
      globalCustomSql === "true" || globalCustomSql === "1" || globalCustomSql === "yes" ? 1 : 0;

    const oldRows = d.prepare("SELECT id, ds_name FROM object").all() as {
      id: number;
      ds_name: string;
    }[];
    const upd = d.prepare(
      "UPDATE object SET db_type=?, db_url=?, db_path=?, cors_origins=?, cors_methods=?, custom_sql_enabled=? WHERE id=?"
    );
    for (const row of oldRows) {
      const ds = dsLookup.get(row.ds_name);
      if (ds) {
        const type = ds.type ?? "sqlite";
        // sqlite 缺路径时兜底配置库 app.db（如内置 sqlite_app 未在 .env 声明 __PATH）
        const path = type === "sqlite" ? (ds.path ?? getDbPath()) : null;
        const url = type === "sqlite" ? null : (ds.url ?? null);
        upd.run(
          type,
          url,
          path,
          ds.corsOrigins ?? null,
          ds.corsMethods ?? null,
          customSqlVal,
          row.id
        );
      } else {
        // 兜底：ds_name 未声明 → 默认 sqlite 指向配置库 app.db
        upd.run("sqlite", null, getDbPath(), null, null, customSqlVal, row.id);
      }
    }
    console.log(`[db] migrated object: ${oldRows.length} row(s) ds_name → new columns`);
  }

  // 3. 删除旧 ds_name 列（迁移完成后）
  if (hasDsName) {
    try {
      d.exec("ALTER TABLE object DROP COLUMN ds_name");
      console.log("[db] upgraded object: dropped legacy column ds_name");
    } catch {
      // SQLite < 3.35 不支持 DROP COLUMN；忽略，不影响功能
    }
  }

  // —— object_table 表迁移：加 3 个批量操作独立开关 ——
  const otNewCols = [
    ["allow_batch_insert", "INTEGER NOT NULL DEFAULT 1"],
    ["allow_batch_update", "INTEGER NOT NULL DEFAULT 1"],
    ["allow_batch_delete", "INTEGER NOT NULL DEFAULT 1"]
  ] as const;
  for (const [col, typeDef] of otNewCols) {
    try {
      d.prepare(`SELECT ${col} FROM object_table LIMIT 0`).get() as unknown;
    } catch {
      d.exec(`ALTER TABLE object_table ADD COLUMN ${col} ${typeDef}`);
      console.log(`[db] upgraded object_table: added column ${col}`);
    }
  }

  // —— 默认项目种子（仅 object 表为空时插入）——
  const objCount = (d.prepare("SELECT COUNT(*) AS c FROM object").get() as { c: number }).c;
  if (objCount === 0) {
    const insObj = d.prepare(
      `INSERT INTO object(name, description, db_type, db_url, db_path, cors_origins, cors_methods, custom_sql_enabled, auth_required)
       VALUES(?,?,?,?,?,?,?,?,?)`
    );
    insObj.run(
      "sqlite_app",
      "内置配置/演示库（users、posts 等表）",
      "sqlite",
      null,
      getDbPath(),
      "*",
      "GET,POST,PUT,DELETE",
      1,
      0
    );
    insObj.run(
      "mysql_orders",
      "MySQL 订单业务库（示例，需本机 MySQL 可用）",
      "mysql",
      "mysql://root:root@127.0.0.1:3306/api_fastify_mysql",
      null,
      "http://localhost:8848,http://10.21.67.168:8848",
      "GET,POST,PUT,PATCH,DELETE",
      0,
      0
    );
    console.log("[db] seeded default objects (sqlite_app, mysql_orders)");
  }

  // —— object_table 种子：为 sqlite_app 内置项目声明至少 posts 表白名单（全局白名单强制）——
  //   任何表都必须在 object_table 中有一行才能被通用接口访问。
  //   配置库自身的表（object/object_table/users/query_template/custom_query_log）
  //   虽然也可以写 object_table 行，但最终还会被 CONFIG_GUARDED_TABLES 拦截 ——
  //   所以我们只给 posts 这种用户数据表白名单，不给配置表白名单。
  try {
    const sqliteAppRow = d.prepare("SELECT id FROM object WHERE name = 'sqlite_app'").get() as
      | { id: number }
      | undefined;
    if (sqliteAppRow) {
      const existing = (
        d.prepare("SELECT COUNT(*) AS c FROM object_table WHERE object_id = ?").get(sqliteAppRow.id) as {
          c: number;
        }
      ).c;
      if (existing === 0) {
        // 用 INSERT OR IGNORE，让后续管理员在 UI 里删除规则后也能自己重建；
        // 这里只是"首次安装 + 内置项目"的最小可用集合。
        const insRule = d.prepare(
          `INSERT OR IGNORE INTO object_table(object_id, table_name, blocked, allow_select, allow_insert, allow_update, allow_delete)
           VALUES(?,?,?,?,?,?,?)`
        );
        // sqlite_app.posts —— 开放给所有操作
        insRule.run(sqliteAppRow.id, "posts", 0, 1, 1, 1, 1);
        console.log("[db] seeded object_table: sqlite_app.posts (CRUD allowed)");
      }
    }
  } catch (e) {
    console.warn("[db] object_table seed step failed (non-fatal):", (e as Error).message);
  }

  // —— object_table 自动补全：遍历所有 SQLite 项目，扫真实表名，自动 INSERT OR IGNORE 白名单规则 ——
  //   任何 sqlite 项目（无论是内置还是用户手动创建的），只要它的 .db 文件里有非系统表，
  //   就自动为每张表补一条 CRUD 全开的规则。幂等、不覆盖已存在的规则。
  //   MySQL/Postgres 项目暂不自动补（initDb 是同步的，mysql2/pg driver 未加载），
  //   管理员可通过管理前端手动加。
  try {
    const sqlites = d.prepare(
      "SELECT id, name, db_path FROM object WHERE db_type = 'sqlite' AND db_path IS NOT NULL AND db_path != ''"
    ).all() as Array<{ id: number; name: string; db_path: string }>;

    const CONFIG_GUARDED_TABLES_SET = new Set([
      "object",
      "object_table",
      "users",
      "query_template",
      "custom_query_log",
      "posts",
      "refresh_tokens",
      "refresh_tokens_expired"
    ]);

    const insRule = d.prepare(
      `INSERT OR IGNORE INTO object_table(object_id, table_name, blocked, allow_select, allow_insert, allow_update, allow_delete)
       VALUES(?,?,?,?,?,?,?)`
    );
    let autoSeededCount = 0;

    for (const obj of sqlites) {
      // 跳过内置 sqlite_app —— 它的表大多是 CONFIG_GUARDED_TABLES，
      // 已在上面手动给 posts 加了规则，其他内部表不应暴露
      if (obj.name === "sqlite_app") continue;

      const absPath = isAbsolute(obj.db_path)
        ? obj.db_path
        : resolve(__dirname, "..", obj.db_path);

      if (!fs.existsSync(absPath)) {
        console.warn(`[db] auto-seed: ${obj.name} 的 db_path 不存在，跳过 (${absPath})`);
        continue;
      }

      let extDb: Database.Database | null = null;
      try {
        extDb = new Database(absPath, { readonly: true });
        const tables = extDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as Array<{ name: string }>;

        for (const t of tables) {
          if (CONFIG_GUARDED_TABLES_SET.has(t.name)) continue;
          const info = insRule.run(obj.id, t.name, 0, 1, 1, 1, 1);
          if (info.changes > 0) {
            autoSeededCount++;
            console.log(`[db] auto-seed: ${obj.name}.${t.name} → 白名单已声明 (CRUD 全开)`);
          }
        }
      } catch (e) {
        console.warn(`[db] auto-seed: 打开 ${obj.name} 失败:`, (e as Error).message);
      } finally {
        if (extDb) extDb.close();
      }
    }
    if (autoSeededCount > 0) {
      console.log(`[db] auto-seed: 共 ${autoSeededCount} 张表自动声明白名单`);
    }
  } catch (e) {
    console.warn("[db] auto-seed step failed (non-fatal):", (e as Error).message);
  }

  // —— 幂等修复：内置 sqlite_app 项目行的 db_path 始终指向配置库（兼容旧迁移数据 db_path=NULL）——
  d.prepare(
    "UPDATE object SET db_path = ?, db_url = NULL WHERE name = 'sqlite_app' AND db_type = 'sqlite' AND (db_path IS NULL OR db_path = '')"
  ).run(getDbPath());

  // —— 清理已过期的 refresh_tokens（启动时执行一次，运行期由 main.ts 的每日定时任务调用）——
  purgeExpiredRefreshTokens();
}

/**
 * 物理删除「已过期」的 refresh_tokens 行。
 *
 * 安全边界：
 *   - 只删 expires_at < 当前时间 的行。过期 refresh_token 无论 valid=0/1 都会被
 *     refresh 接口拒绝（先判 expires_at），删除它们对鉴权零影响，纯属空间回收。
 *   - 「未过期但 valid=0」（已用/登出/被盗作废）的行**不删**：它们在 7 天有效期内
 *     仍承担 reuse detection——旧 token 被再次出示时要靠读到这行来整 family 作废。
 *     这些行到期后自然落入本函数的删除范围，无需单独处理。
 *
 * @returns 实际删除的行数
 */
export function purgeExpiredRefreshTokens(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const res = getDb().prepare("DELETE FROM refresh_tokens WHERE expires_at < ?").run(nowSec);
  return res.changes;
}

/**
 * 仅当传入的 Database 实例路径 === 默认配置库路径（getDbPath()）时，
 * 执行 initDb 建表 + 种子 + 迁移。用于 SqliteDataSource.open() 判断是否需要初始化。
 *
 * 业务数据源（demo.db 等）不应触发建表——它们的 schema 由用户自己准备。
 */
export async function initDbIfAppDb(db: Database.Database): Promise<void> {
  // db.name 是 better-sqlite3 打开的文件路径
  if (db.name === getDbPath()) {
    await initDb(db);
  }
}
