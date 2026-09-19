/**
 * admin-panel scope 隔离 + /api/admin/db/* 管理端接口 —— 安全防线测试
 *
 * 覆盖 6 组关键行为：
 *   1. .env ADMIN_USERNAME/ADMIN_PASSWORD 登录 → JWT 带 scope="admin-panel"
 *   2. 业务用户（users 表登录，无 scope）→ 访问管理接口被 403
 *   3. legacy admin（object_id=-1 但无 scope）→ 访问管理接口被 403（scope 层拦截）
 *   4. admin-panel JWT 能调全部管理端点（db/* + config/* + users + restart）
 *   5. /api/admin/db/query 安全守卫：非 SELECT/DROP 等被拒
 *   6. /api/admin/db/delete / update 必须有 WHERE（防误全表操作）
 *   7. .env ADMIN_PASSWORD 支持 bcrypt 哈希格式
 *
 * 这些测试锁死「admin 面板只能被 admin-vue 前端访问」这条核心安全防线。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  teardownTestApp,
  injectJson,
  loginForTest,
  authHeaders,
} from "../helper-object.js";
import { decodeToken } from "../../src/services/auth.service.js";

// —— 手写 HMAC-SHA256 JWT（三段 base64url）——
function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64url(header);
  const p = b64url(payload);
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${h}.${p}.${sig}`;
}

let app: FastifyInstance;

before(async () => {
  app = await buildTestApp();
});

after(async () => {
  await teardownTestApp(app);
});

// =====================================================================
// 1. .env 管理员登录 → JWT 带 scope="admin-panel"
// =====================================================================
describe("POST /api/auth/login — .env admin 登录签发 admin-panel scope", () => {
  it("admin/admin123 登录成功，JWT scope=admin-panel", async () => {
    const creds = await loginForTest(app, "admin", "admin123");
    const payload = decodeToken(creds.access_token);
    assert.equal(payload.scope, "admin-panel", "admin 登录的 JWT 必须带 scope=admin-panel");
    assert.equal(payload.object_id, -1);
    assert.equal(payload.username, "admin");
    assert.equal(payload.type, "access");
  });

  it("refresh 后 scope 保留", async () => {
    const first = await loginForTest(app, "admin", "admin123");
    // 关键：refresh 必须带与登录时相同的 x-client-id，否则 fp 不匹配 → 401
    const r = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: first.refresh_token },
      { "x-client-id": "test-client", "content-type": "application/json" }
    );
    assert.equal(r.statusCode, 200, `refresh 应返回 200，实际 ${r.statusCode}: ${r.payload}`);
    const body = JSON.parse(r.payload);
    const payload = decodeToken(body.data.access_token);
    assert.equal(payload.scope, "admin-panel");
  });

  it("me 端点能正确识别 admin-panel token", async () => {
    const creds = await loginForTest(app, "admin", "admin123");
    const r = await injectJson(app, "GET", "/api/auth/me", undefined, authHeaders(creds.access_token));
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.data.username, "admin");
    assert.equal(body.data.object_id, -1);
  });
});

// =====================================================================
// 2. 业务用户（users 表登录）— 无 scope → 403 所有管理端接口
// =====================================================================
describe("业务用户无 scope — 所有管理接口 403", () => {
  let demoToken: string;
  before(async () => {
    const creds = await loginForTest(app, "demo", "demo123");
    const payload = decodeToken(creds.access_token);
    // 确认 demo 的 JWT 没有 scope 字段 —— 这是隔离的前提
    assert.equal(payload.scope, undefined, "业务用户 JWT 不应带 scope");
    demoToken = creds.access_token;
  });

  it("GET /api/admin/db/tables → 403", async () => {
    const r = await injectJson(app, "GET", "/api/admin/db/tables", undefined, authHeaders(demoToken));
    assert.equal(r.statusCode, 403);
  });

  it("GET /api/admin/db/meta → 403", async () => {
    const r = await injectJson(app, "GET", "/api/admin/db/meta", undefined, authHeaders(demoToken));
    assert.equal(r.statusCode, 403);
  });

  it("POST /api/admin/db/query → 403", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/query",
      { sql: "SELECT 1" },
      authHeaders(demoToken)
    );
    assert.equal(r.statusCode, 403);
  });

  it("POST /api/admin/db/insert → 403", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/insert",
      { table: "users", data: { username: "x" } },
      authHeaders(demoToken)
    );
    assert.equal(r.statusCode, 403);
  });

  it("POST /api/admin/db/update → 403", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/update",
      { table: "users", data: { username: "y" }, where: "id = ?", whereParams: [1] },
      authHeaders(demoToken)
    );
    assert.equal(r.statusCode, 403);
  });

  it("POST /api/admin/db/delete → 403", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/delete",
      { table: "users", where: "id = ?", whereParams: [1] },
      authHeaders(demoToken)
    );
    assert.equal(r.statusCode, 403);
  });

  it("POST /api/admin/db/checkpoint → 403", async () => {
    const r = await injectJson(app, "POST", "/api/admin/db/checkpoint", {}, authHeaders(demoToken));
    assert.equal(r.statusCode, 403);
  });

  it("POST /api/admin/db/refresh-tokens/cleanup → 403", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/refresh-tokens/cleanup",
      {},
      authHeaders(demoToken)
    );
    assert.equal(r.statusCode, 403);
  });

  it("GET /api/config/objects → 403", async () => {
    const r = await injectJson(app, "GET", "/api/config/objects", undefined, authHeaders(demoToken));
    assert.equal(r.statusCode, 403);
  });

  it("POST /api/users → 403", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/users",
      { username: "x", nickname: "y", password: "z", object_id: 1 },
      authHeaders(demoToken)
    );
    assert.equal(r.statusCode, 403);
  });

  it("POST /api/system/restart → 403", async () => {
    // 需要 ALLOW_SYSTEM_RESTART=true 才会存在
    process.env.ALLOW_SYSTEM_RESTART = "true";
    const r = await injectJson(app, "POST", "/api/system/restart", {}, authHeaders(demoToken));
    assert.equal(r.statusCode, 403);
    delete process.env.ALLOW_SYSTEM_RESTART;
  });
});

// =====================================================================
// 3. 手动构造 legacy admin token（object_id=-1 但无 scope）→ 被 scope 层拦截
// =====================================================================
describe("legacy admin（object_id=-1 无 scope）→ scope 层 403", () => {
  let legacyAdminToken: string;

  before(() => {
    // 用测试 JWT_SECRET 手动签发一个 admin JWT：object_id=-1 但没有 scope
    // 绕过 createToken 的 scope 自动注入，确保真实 verify 链路能解开但 scope 校验失败
    const secret = process.env.JWT_SECRET ?? "test-secret-for-unit-tests-2026";
    const now = Math.floor(Date.now() / 1000);
    // 指纹计算规则：sha256("cid:" + x-client-id) —— 必须与后端 computeClientFingerprint 一致
    const source = "cid:test-fingerprint";
    const fp = crypto.createHash("sha256").update(source).digest("hex");
    legacyAdminToken = signJwt(
      {
        sub: 1,
        username: "admin",
        nickname: "legacy",
        object_id: -1,
        tv: 1,
        fp,
        type: "access",
        jti: "legacy-" + now,
        // 注意：没有 scope 字段
        exp: now + 7200,
        iat: now,
      },
      secret
    );
  });

  it("GET /api/admin/db/tables → 403（verifyToken 层 object_id<=0 拦截，无 scope 的 legacy token 业务用户身份不成立）", async () => {
    // 关键：用 legacy 指纹发请求 —— verifyToken 的指纹比对会成功
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/db/tables",
      headers: {
        "x-client-id": "test-fingerprint",
        "authorization": `Bearer ${legacyAdminToken}`,
      },
    });
    assert.equal(r.statusCode, 403);
    const body = JSON.parse(r.payload);
    // 确认是 verifyToken 层拦住：无 admin-panel scope → 走业务用户检查 → object_id=-1 被拒
    assert.match(body.error ?? "", /禁用|scope|object_id|flag/i);
  });

  it("GET /api/config/objects → 同样被 403", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/config/objects",
      headers: {
        "x-client-id": "test-fingerprint",
        "authorization": `Bearer ${legacyAdminToken}`,
      },
    });
    assert.equal(r.statusCode, 403);
  });
});

// =====================================================================
// 4. admin-panel JWT 能调全部管理端点
// =====================================================================
describe("admin-panel JWT → 全部管理端点 2xx", () => {
  let adminToken: string;
  before(async () => {
    const creds = await loginForTest(app, "admin", "admin123");
    adminToken = creds.access_token;
  });

  // —— /api/admin/db/* ——

  it("GET /api/admin/db/tables → 200 + ok=true + 有 tables 数组", async () => {
    const r = await injectJson(app, "GET", "/api/admin/db/tables", undefined, authHeaders(adminToken));
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.tables));
    assert.ok(body.tables.length >= 3); // object + users + refresh_tokens + ...
    for (const t of body.tables) {
      assert.ok(typeof t.name === "string");
      assert.ok(typeof t.rows === "number");
    }
  });

  it("GET /api/admin/db/meta → 200 + journalMode=wal", async () => {
    const r = await injectJson(app, "GET", "/api/admin/db/meta", undefined, authHeaders(adminToken));
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.ok, true);
    assert.equal(body.journalMode, "wal");
    assert.ok(body.tables >= 3);
    assert.ok(typeof body.rowCounts.users === "number");
    assert.ok(typeof body.rowCounts.object === "number");
  });

  it("GET /api/admin/db/table/users → 200 + 含 admin + demo 行", async () => {
    const r = await injectJson(
      app,
      "GET",
      "/api/admin/db/table/users?limit=10",
      undefined,
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.ok, true);
    assert.equal(body.table, "users");
    assert.ok(Array.isArray(body.rows));
    const usernames = body.rows.map((row: Record<string, unknown>) => row.username);
    assert.ok(usernames.includes("admin"));
    assert.ok(usernames.includes("demo"));
  });

  it("POST /api/admin/db/query SELECT → 200 + 返回行", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/query",
      { sql: "SELECT id, username, object_id FROM users WHERE object_id = ?", params: [-1] },
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.rows));
    assert.equal(body.rows.length, 1); // admin shadow 行
    assert.equal(body.rows[0].username, "admin");
  });

  it("POST /api/admin/db/insert → 200 + 返回 lastInsertRowid", async () => {
    // 插一个临时 object 行（用随机 name 避免 UNIQUE 冲突）
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/insert",
      {
        table: "object",
        data: {
          name: `_tmp_test_${Date.now()}`,
          description: "temp for test",
          db_type: "sqlite",
          auth_required: 0,
          custom_sql_enabled: 0,
        },
      },
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.ok, true);
    assert.equal(body.changes, 1);
    assert.ok(typeof body.lastInsertRowid === "number");
    const newId = body.lastInsertRowid as number;

    // 插完 update 一下 description
    const r2 = await injectJson(
      app,
      "POST",
      "/api/admin/db/update",
      {
        table: "object",
        data: { description: "temp updated" },
        where: "id = ?",
        whereParams: [newId],
      },
      authHeaders(adminToken)
    );
    assert.equal(r2.statusCode, 200);
    assert.equal(JSON.parse(r2.payload).changes, 1);

    // 再删掉（WHERE 必需）
    const r3 = await injectJson(
      app,
      "POST",
      "/api/admin/db/delete",
      { table: "object", where: "id = ?", whereParams: [newId] },
      authHeaders(adminToken)
    );
    assert.equal(r3.statusCode, 200);
    assert.equal(JSON.parse(r3.payload).changes, 1);
  });

  it("POST /api/admin/db/refresh-tokens/cleanup → 200", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/refresh-tokens/cleanup",
      {},
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.ok, true);
    assert.ok(typeof body.removed === "number");
  });

  it("POST /api/admin/db/checkpoint → 200 + 含 busy/log/checkpointed", async () => {
    const r = await injectJson(app, "POST", "/api/admin/db/checkpoint", {}, authHeaders(adminToken));
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.payload);
    assert.equal(body.ok, true);
    // better-sqlite3 pragma("wal_checkpoint(...)") 返回数组 [{busy, log, checkpointed}]
    const res = Array.isArray(body.result) ? body.result[0] : body.result;
    assert.ok(typeof res.busy === "number");
    assert.ok(typeof res.log === "number");
    assert.ok(typeof res.checkpointed === "number");
  });

  // —— 其他管理端点 ——

  it("GET /api/config/objects → 200（admin-panel 放行）", async () => {
    const r = await injectJson(app, "GET", "/api/config/objects", undefined, authHeaders(adminToken));
    assert.equal(r.statusCode, 200);
  });

  it("GET /api/users → 200", async () => {
    const r = await injectJson(app, "GET", "/api/users", undefined, authHeaders(adminToken));
    assert.equal(r.statusCode, 200);
  });

  it("POST /api/system/restart → 404（默认 ALLOW_SYSTEM_RESTART 未设置，端点隐藏）", async () => {
    // 重启端点默认关闭（ALLOW_SYSTEM_RESTART 未设 → 404 隐藏）
    const r = await injectJson(app, "POST", "/api/system/restart", {}, authHeaders(adminToken));
    assert.equal(r.statusCode, 404);
  });
});

// =====================================================================
// 5. /api/admin/db/query 安全守卫 —— 非 SELECT / 危险关键字被拒
// =====================================================================
describe("POST /api/admin/db/query — 安全守卫", () => {
  let adminToken: string;
  before(async () => {
    adminToken = (await loginForTest(app, "admin", "admin123")).access_token;
  });

  const mustReject = (label: string, sql: string) => {
    it(`${label} → 400`, async () => {
      const r = await injectJson(
        app,
        "POST",
        "/api/admin/db/query",
        { sql },
        authHeaders(adminToken)
      );
      assert.equal(r.statusCode, 400, `${label} 应返回 400，实际 ${r.statusCode}: ${r.payload}`);
    });
  };

  mustReject("INSERT 语句", "INSERT INTO users(username) VALUES('x')");
  mustReject("UPDATE 语句", "UPDATE users SET username='x' WHERE id=1");
  mustReject("DELETE 语句", "DELETE FROM users WHERE id=1");
  mustReject("DROP 语句", "DROP TABLE users");
  mustReject("CREATE 语句", "CREATE TABLE evil(x TEXT)");
  mustReject("ALTER 语句", "ALTER TABLE users ADD y TEXT");
  mustReject("ATTACH 语句", "ATTACH ':memory:' AS m");
  mustReject("DETACH 语句", "DETACH m");
  mustReject("VACUUM 语句", "VACUUM");
  mustReject("SELECT 里含 INSERT（关键字黑名单）", "SELECT 1; INSERT INTO users VALUES('x')");
  mustReject("SELECT 里含 DROP", "SELECT * FROM users; DROP TABLE object");
});

// =====================================================================
// 6. delete / update 必须有 WHERE —— 防误全表操作
// =====================================================================
describe("admin/db delete & update —— WHERE 必填", () => {
  let adminToken: string;
  before(async () => {
    adminToken = (await loginForTest(app, "admin", "admin123")).access_token;
  });

  it("POST /api/admin/db/delete 无 where → 400", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/delete",
      { table: "users" },
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 400);
    assert.match(JSON.parse(r.payload).error ?? "", /where|误删|全表|非空/i);
  });

  it("POST /api/admin/db/delete where 为空字符串 → 400", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/delete",
      { table: "users", where: "", whereParams: [] },
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 400);
  });

  it("POST /api/admin/db/delete where 不是字符串 → 400", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/delete",
      { table: "users", where: 123 },
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 400);
  });

  it("POST /api/admin/db/update 无 where → 400", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/update",
      { table: "users", data: { nickname: "x" } },
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 400);
  });

  it("POST /api/admin/db/update data 为空对象 → 400", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/update",
      { table: "users", data: {}, where: "1=1", whereParams: [] },
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 400);
    assert.match(JSON.parse(r.payload).error ?? "", /不能为空|empty/i);
  });

  it("POST /api/admin/db/query sql 为空 → 400", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/query",
      { sql: "" },
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 400);
  });

  it("POST /api/admin/db/query sql 不是字符串 → 400", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/admin/db/query",
      { sql: 123 },
      authHeaders(adminToken)
    );
    assert.equal(r.statusCode, 400);
  });
});

// =====================================================================
// 7. .env ADMIN_PASSWORD bcrypt 哈希格式支持
// =====================================================================
describe(".env ADMIN_PASSWORD —— bcrypt 哈希格式", () => {
  let adminTokenPlain: string;
  before(async () => {
    adminTokenPlain = (await loginForTest(app, "admin", "admin123")).access_token;
  });

  it("明文密码正常登录（setup-env 默认明文 admin123）", () => {
    assert.ok(adminTokenPlain);
    const payload = decodeToken(adminTokenPlain);
    assert.equal(payload.scope, "admin-panel");
  });

  it("伪造 bcrypt 哈希 + 错误密码 → 登录失败（401）", async () => {
    // 临时改 env 为一个真 bcrypt 哈希，再用错误密码尝试
    const original = process.env.ADMIN_PASSWORD;
    // admin123 的 bcrypt cost=4 哈希（已知正确）
    process.env.ADMIN_PASSWORD =
      "$2b$04$49VdB3zpadj/.aueeKrZweY2GUMoCHWhsqU3eGCAvKRdSxprsyDIm";
    try {
      const r = await injectJson(
        app,
        "POST",
        "/api/auth/login",
        { username: "admin", password: "wrong-password" },
        { "x-client-id": "test-client", "content-type": "application/json" }
      );
      assert.equal(r.statusCode, 401);
    } finally {
      process.env.ADMIN_PASSWORD = original!;
    }
  });
});
