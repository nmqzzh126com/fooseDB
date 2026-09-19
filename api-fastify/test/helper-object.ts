/**
 * 元数据驱动通用接口 —— 测试辅助。
 *
 * 提供构建测试用 Fastify 实例、登录获取 token、JSON 注入请求等工具。
 * 数据源注册为单例（registerAll 只执行一次），多个测试文件共享同一注册表。
 *
 * 关于鉴权：
 *   自「users.object_id 用户-项目绑定」改造后，所有管理端写/读接口
 *   （/api/config/*、/api/users）都要求调用方携带 system admin（object_id=-1）
 *   的 Bearer token。为了让既有测试代码不必每个调用都手工传 admin token，
 *   本 helper 内管理端调用统一注入：
 *     · createTestObject / createTableRule / deleteTestObject
 *           → 内部先 lazy 调 loginForTest("admin","admin123")，再把 authHeaders(token) 合并到请求头
 */

import "./setup-env.js"; // 必须第一行导入，设置环境变量

import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import autoload from "@fastify/autoload";
import { registerAll } from "../src/datasources/registry.js";
import { registerAllCaches } from "../src/caches/registry.js";
import { _resetEnvCache } from "../src/config/env.js";
import { getDbPath } from "../src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _dsReady = false;

/** 确保数据源已初始化（单例，整个进程只执行一次）。
 *  测试只注册内置 sqlite_app；其余测试项目通过 createTestObject → createObject → registerObjectDs 动态注册，
 *  避免 bulkRegister 扫描并连接种子里的 mysql_orders（真实 MySQL 连接池会让测试进程无法退出）。 */
async function ensureDatasources(): Promise<void> {
  if (_dsReady) return;
  _resetEnvCache();
  await registerAll();
  await registerAllCaches();
  _dsReady = true;
}

/** 构建测试用 Fastify 实例（无静态文件、无 listen，仅 plugins + routes） */
export async function buildTestApp(): Promise<FastifyInstance> {
  await ensureDatasources();

  const app = Fastify({ logger: false });

  await app.register(autoload, {
    dir: join(__dirname, "..", "src", "plugins"),
  });
  await app.register(autoload, {
    dir: join(__dirname, "..", "src", "routes"),
    dirNameRoutePrefix: false,
  });

  return app;
}

/** 关闭测试用 Fastify 实例（不关闭数据源单例，供其他测试文件复用） */
export async function teardownTestApp(app: FastifyInstance): Promise<void> {
  await app.close();
}

/** 登录并返回 access_token + refresh_token。固定 X-Client-Id=test-client，与 authHeaders 产生的 fp 一致。 */
export async function loginForTest(
  app: FastifyInstance,
  username = "admin",
  password = "admin123"
): Promise<{ access_token: string; refresh_token: string; expires: number }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json", "x-client-id": "test-client" },
    payload: JSON.stringify({ username, password }),
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.payload}`);
  }
  const body = JSON.parse(res.payload);
  // 兼容两种结构：auth.ts 新版返回  data = {expires, access_token, refresh_token}；旧版可能直接平铺
  return body.data ?? body;
}

/** admin 用户（object_id=-1 系统管理员）的懒缓存 token。
 *  所有管理端 helper（createTestObject / createTableRule 等）统一用这个 token 访问受保护接口。
 */
let _adminCachedPromise:
  | Promise<{ access_token: string; refresh_token: string; expires: number }>
  | null = null;
export async function adminAccessToken(app: FastifyInstance): Promise<string> {
  if (!_adminCachedPromise) _adminCachedPromise = loginForTest(app, "admin", "admin123");
  const creds = await _adminCachedPromise;
  // 过期前 5 分钟刷新
  if (creds.expires - Math.floor(Date.now() / 1000) < 300) {
    _adminCachedPromise = loginForTest(app, "admin", "admin123");
    return (await _adminCachedPromise).access_token;
  }
  return creds.access_token;
}

/** 构建一个带 system admin Bearer token 的请求头（auth-context 兼容指纹 x-client-id: test-client）
 *  用于在测试里匿名调用管理端 GET/POST/PUT/DELETE 时，快速通过 sysadmin 准入。
 */
export async function adminHeaders(
  app: FastifyInstance
): Promise<Record<string, string>> {
  return authHeaders(await adminAccessToken(app));
}

/** 构建带客户端指纹（和可选 Bearer token）的请求头 */
export function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { "x-client-id": "test-client" };
  if (token) h["authorization"] = `Bearer ${token}`;
  return h;
}

/** 快捷 JSON 注入请求 */
export async function injectJson(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  return app.inject({
    method,
    url,
    payload: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** app.db 绝对路径（测试默认用配置库作为数据源）。
 *  测试时被 setup-env.ts 注入 APP_DB_PATH_FOR_TESTS → 落到 os.tmpdir() 临时库；
 *  非测试场景无覆盖 → 正常指向 data/app.db。 */
export const APP_DB_PATH = getDbPath();

/** 创建测试项目并返回完整行（名称默认随机，避免冲突）—— 内部以管理员身份调用，因为管理端创建接口需 sysadmin */
export async function createTestObject(
  app: FastifyInstance,
  overrides: Partial<{
    name: string;
    description: string;
    db_type: string;
    db_url: string | null;
    db_path: string | null;
    cors_origins: string | null;
    cors_methods: string | null;
    custom_sql_enabled: number;
    auth_required: number;
  }> = {}
) {
  const adminTok = await adminAccessToken(app);
  const name =
    overrides.name ??
    `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await injectJson(app, "POST", "/api/config/objects", {
    name,
    description: overrides.description ?? "test object",
    db_type: overrides.db_type ?? "sqlite",
    db_url: overrides.db_url ?? null,
    db_path: overrides.db_path ?? APP_DB_PATH,
    cors_origins: overrides.cors_origins ?? null,
    cors_methods: overrides.cors_methods ?? null,
    custom_sql_enabled: overrides.custom_sql_enabled ?? 1,
    auth_required: overrides.auth_required ?? 0,
  }, authHeaders(adminTok));
  if (res.statusCode !== 201) {
    throw new Error(`createTestObject failed: ${res.statusCode} ${res.payload}`);
  }
  const row = JSON.parse(res.payload) as {
    id: number;
    name: string;
    description: string | null;
    db_type: string;
    db_url: string | null;
    db_path: string | null;
    cors_origins: string | null;
    cors_methods: string | null;
    custom_sql_enabled: number;
    auth_required: number;
    created_at: number;
  };

  // 严格白名单模式：创建项目后默认为 posts 表声明全放行规则，
  // 让测试代码可以直接 /api/:object/posts 做 CRUD 验证。
  // 某些测试（比如 blocked / allow_insert=0）会自己覆盖或修改此规则。
  await createTableRule(app, row.id, {
    table_name: "posts",
    blocked: 0,
    allow_select: 1,
    allow_insert: 1,
    allow_update: 1,
    allow_delete: 1,
  }).catch(() => {
    // 某些项目用的 db 可能没有 posts 表（比如 MySQL demo），
    // createTableRule 内部用 admin token 应该不会 403，但如果底层 DB 真有问题就跳过。
  });

  return row;
}

/** 删除测试项目（按 id，静默失败）—— 管理员身份 */
export async function deleteTestObject(
  app: FastifyInstance,
  id: number
): Promise<void> {
  const adminTok = await adminAccessToken(app);
  await app.inject({
    method: "DELETE",
    url: `/api/config/objects/${id}`,
    headers: authHeaders(adminTok),
  });
}

/** 为项目创建表级限制规则并返回完整行 —— 管理员身份（写接口需 sysadmin）
 *  幂等语义：遇到 409（UNIQUE 冲突，规则已存在）时，改为 PUT 更新现有规则行，
 *  让新的 blocked/allow_* 设置生效。这样 createTestObject 自动创建 posts 规则后，
 *  测试代码里再次调用本函数来调整规则（比如设 allow_insert=0）也能真正生效。 */
export async function createTableRule(
  app: FastifyInstance,
  objectId: number,
  input: {
    table_name: string;
    blocked?: number;
    allow_select?: number;
    allow_insert?: number;
    allow_update?: number;
    allow_delete?: number;
  }
) {
  const adminTok = await adminAccessToken(app);
  const body = { object_id: objectId, ...input };
  const res = await injectJson(
    app,
    "POST",
    `/api/config/tables`,
    body,
    authHeaders(adminTok)
  );
  if (res.statusCode === 201) {
    return JSON.parse(res.payload);
  }
  // 409 UNIQUE 冲突 → 规则已存在，PUT 更新为请求的设置
  if (res.statusCode === 409) {
    const listRes = await app.inject({
      method: "GET",
      url: `/api/config/objects/${objectId}/tables`,
      headers: authHeaders(adminTok),
    });
    if (listRes.statusCode !== 200) {
      throw new Error(
        `createTableRule: 409 后 GET 列表失败: ${listRes.statusCode} ${listRes.payload}`
      );
    }
    const page = JSON.parse(listRes.payload) as {
      items: Array<{
        id: number;
        table_name: string;
        blocked: number;
        allow_select: number;
        allow_insert: number;
        allow_update: number;
        allow_delete: number;
      }>;
    };
    const match = page.items.find(r => r.table_name === input.table_name);
    if (!match) {
      throw new Error(
        `createTableRule: 409 后 GET 列表找不到 table_name=${input.table_name}`
      );
    }
    // PUT 更新（只传有意义的字段，不传的保持不变）
    const updatePayload: Record<string, number> = {};
    if (input.blocked !== undefined) updatePayload.blocked = input.blocked ? 1 : 0;
    if (input.allow_select !== undefined) updatePayload.allow_select = input.allow_select ? 1 : 0;
    if (input.allow_insert !== undefined) updatePayload.allow_insert = input.allow_insert ? 1 : 0;
    if (input.allow_update !== undefined) updatePayload.allow_update = input.allow_update ? 1 : 0;
    if (input.allow_delete !== undefined) updatePayload.allow_delete = input.allow_delete ? 1 : 0;

    const putRes = await injectJson(
      app,
      "PUT",
      `/api/config/tables/${match.id}`,
      updatePayload,
      authHeaders(adminTok)
    );
    if (putRes.statusCode === 200) {
      return JSON.parse(putRes.payload);
    }
    throw new Error(
      `createTableRule: PUT 更新失败: ${putRes.statusCode} ${putRes.payload}`
    );
  }
  throw new Error(`createTableRule failed: ${res.statusCode} ${res.payload}`);
}
