/**
 * 认证相关专项测试：
 *   P1/P2/P3    token_version 代次作废 + fingerprint 绑定
 *   P4/P5       refresh_token 轮换 + reuse detection + logout
 *
 * 所有用例基于 helper-object.ts 的 buildTestApp() / injectJson() / loginForTest() / authHeaders()。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  teardownTestApp,
  injectJson,
  loginForTest,
  authHeaders,
  createTestObject,
  createTableRule,
  deleteTestObject,
  adminHeaders,
  APP_DB_PATH,
} from "../helper-object.js";
import { decodeToken, bumpUserTokenVersion, computeClientFingerprint } from "../../src/services/auth.service.js";
import { getDb } from "../../src/db.js";

let app: FastifyInstance;

before(async () => {
  app = await buildTestApp();
});

after(async () => {
  await teardownTestApp(app);
});

// ----------------------------------------------------------------------------
// 1. 登录返回正确结构（access + refresh 双 token + tv/jti/fp 均存在于 payload）
// ----------------------------------------------------------------------------
describe("POST /api/auth/login — 返回双 token + tv/jti/fp 结构正确", () => {
  it("login 200: envelope data + 双 token + expires + token_type", async () => {
    const creds = await loginForTest(app, "admin", "admin123");
    assert.ok(typeof creds.access_token === "string" && creds.access_token.length > 0);
    assert.ok(typeof creds.refresh_token === "string" && creds.refresh_token.length > 0);
    assert.ok(Number.isFinite(creds.expires) && creds.expires > Math.floor(Date.now() / 1000));
    // loginForTest 返回解包后的 data = LoginResult，但 LoginResult 还有 refresh_expires + token_type：
    const raw = (creds as unknown) as { token_type?: string; refresh_expires?: number };
    assert.equal(raw.token_type, "Bearer");
    assert.ok(Number.isFinite(raw.refresh_expires) && raw.refresh_expires! > creds.expires);
  });

  it("login: access_token payload 里有 tv（token_version） + jti（唯一 ID） + fp（指纹） + type=access", async () => {
    const creds = await loginForTest(app, "admin", "admin123");
    const accessPayload = decodeToken(creds.access_token);
    assert.equal(accessPayload.type, "access");
    assert.ok(Number.isFinite(accessPayload.tv) && accessPayload.tv! >= 1);
    assert.ok(typeof accessPayload.jti === "string" && accessPayload.jti.length > 0);
    assert.ok(typeof accessPayload.fp === "string" && /^[0-9a-f]{64}$/.test(accessPayload.fp));
    assert.equal(accessPayload.username, "admin");

    const refreshPayload = decodeToken(creds.refresh_token);
    assert.equal(refreshPayload.type, "refresh");
    assert.equal(refreshPayload.tv, accessPayload.tv);
    assert.ok(typeof refreshPayload.jti === "string" && refreshPayload.jti.length > 0);
    assert.equal(refreshPayload.fp, accessPayload.fp);
  });
});

// ----------------------------------------------------------------------------
// 2. refresh 成功：generation +1，旧 refresh valid 变 0，新 jti 新 token
// ----------------------------------------------------------------------------
describe("POST /api/auth/refresh — 成功轮换 generation+1", () => {
  it("refresh 200: 返回新 token 对，jti 与原不同，原 refresh_jti 对应行已作废", async () => {
    const first = await loginForTest(app, "admin", "admin123");
    const firstRefreshPayload = decodeToken(first.refresh_token);
    assert.ok(firstRefreshPayload.jti);

    const r = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: first.refresh_token },
      authHeaders()
    );
    assert.equal(r.statusCode, 200, `refresh failed: ${r.payload}`);
    const body = JSON.parse(r.payload) as {
      data: { access_token: string; refresh_token: string; token_type: string };
    };
    assert.equal(body.data.token_type, "Bearer");
    assert.notEqual(body.data.refresh_token, first.refresh_token);

    const newRefreshPayload = decodeToken(body.data.refresh_token);
    assert.ok(newRefreshPayload.jti);
    assert.notEqual(newRefreshPayload.jti, firstRefreshPayload.jti);
    // 同一家族：sub + fp 必须相同
    assert.equal(newRefreshPayload.sub, firstRefreshPayload.sub);
    assert.equal(newRefreshPayload.fp, firstRefreshPayload.fp);
  });
});

// ----------------------------------------------------------------------------
// 3. refresh 拒绝类型错误：把 access_token 当 refresh 传 → 400
// ----------------------------------------------------------------------------
describe("POST /api/auth/refresh — 入参校验", () => {
  it("用 access_token 当 refresh_token → 400 not a refresh token", async () => {
    const creds = await loginForTest(app, "admin", "admin123");
    const r = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: creds.access_token },
      authHeaders()
    );
    assert.equal(r.statusCode, 400);
    assert.match(JSON.parse(r.payload).error, /not a refresh token/);
  });

  it("传明显非法 JWT → 401 invalid token signature", async () => {
    const r = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: "not.a.jwt" },
      authHeaders()
    );
    assert.ok(r.statusCode === 401 || r.statusCode === 400, `expected 401/400 got ${r.statusCode}`);
  });
});

// ----------------------------------------------------------------------------
// 4. Reuse Detection：同一个 refresh 第二次用 → 整 family 作废 → 401 reuse detected
// ----------------------------------------------------------------------------
describe("POST /api/auth/refresh — Reuse Detection", () => {
  it("同一 refresh 被二次使用 → 401 reuse detected，新 refresh 也不能续", async () => {
    const creds = await loginForTest(app, "admin", "admin123");

    // 第一次：成功
    const r1 = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: creds.refresh_token },
      authHeaders()
    );
    assert.equal(r1.statusCode, 200, `refresh first failed: ${r1.payload}`);
    const second = JSON.parse(r1.payload).data as { refresh_token: string };

    // 第二次（同一 original refresh）→ reuse 触发
    const r2 = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: creds.refresh_token },
      authHeaders()
    );
    assert.equal(r2.statusCode, 401);
    assert.match(JSON.parse(r2.payload).error, /reuse detected|re-login required/);

    // 副作用：整 family 作废，第一次 refresh 返回的新 token 也没法续（同一 family）
    const r3 = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: second.refresh_token },
      authHeaders()
    );
    assert.equal(r3.statusCode, 401, `expected family invalidated, got ${r3.statusCode}: ${r3.payload}`);
    assert.match(JSON.parse(r3.payload).error, /reuse|re-login required/);
  });
});

// ----------------------------------------------------------------------------
// 5. fingerprint 严格绑定：用不同 X-Client-Id 请求 refresh（fp 与签发不一致）
//    → 401 client mismatch / re-login required，整 family 作废
// ----------------------------------------------------------------------------
describe("POST /api/auth/refresh — 指纹严格绑定", () => {
  it("换 X-Client-Id 再次 refresh → 401 fp_mismatch 家族作废", async () => {
    // 先登录（x-client-id: test-client → fp1）
    const creds = await loginForTest(app, "admin", "admin123");
    const pBefore = decodeToken(creds.refresh_token);
    const expectedReqFp = computeClientFingerprint("another-device", undefined);
    const expectedLoginFp = computeClientFingerprint("test-client", undefined);
    assert.equal(pBefore.fp, expectedLoginFp, "签发端 fp 必须是 test-client 的");
    assert.notEqual(pBefore.fp, expectedReqFp, "签发端 fp != 请求端 another-device fp");
    // refresh 时换 x-client-id → fp2
    const r = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: creds.refresh_token },
      // 故意用另一个设备指纹
      { "x-client-id": "another-device", "content-type": "application/json" }
    );
    assert.equal(r.statusCode, 401, `expected 401 fp mismatch, got ${r.statusCode}: ${r.payload}`);
    const err1 = JSON.parse(r.payload).error;
    assert.match(err1, /client mismatch|re-login required/);

    // 副作用：原 fp 的 refresh 也作废（家族已因 fp_mismatch 被 markFamilyInvalid）
    const r2 = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: creds.refresh_token },
      authHeaders()
    );
    assert.equal(r2.statusCode, 401, `r2 expected 401 (family already invalidated), got ${r2.statusCode}: ${r2.payload}`);
  });
});

// ----------------------------------------------------------------------------
// 6. token_version（TV）机制：bumpUserTokenVersion 后，旧 access_token 请求 /me → 401 revoked
// ----------------------------------------------------------------------------
describe("P3 token_version 代次吊销", () => {
  it("bump TV 后，旧 access_token 访问 /me → 401 token revoked (version mismatch)", async () => {
    const creds = await loginForTest(app, "admin", "admin123");
    const me1 = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authHeaders(creds.access_token),
    });
    assert.equal(me1.statusCode, 200, `/me 正常应 200: ${me1.payload}`);
    const adminUid = decodeToken(creds.access_token).sub;
    assert.ok(typeof adminUid === "number" && adminUid > 0);

    // 手动 bump：模拟「改密 / 管理员踢人」
    bumpUserTokenVersion(adminUid);

    const me2 = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authHeaders(creds.access_token),
    });
    assert.equal(me2.statusCode, 401, `bump TV 后旧 access 应 401, got ${me2.statusCode}: ${me2.payload}`);
    assert.match(JSON.parse(me2.payload).error, /version mismatch|revoked/);
  });
});

// ----------------------------------------------------------------------------
// 7. logout：POST /api/auth/logout 撤销自己的 refresh family；后续 refresh 应失败
// ----------------------------------------------------------------------------
describe("POST /api/auth/logout — 注销", () => {
  it("logout(body.refresh_token + Bearer) → revoked ≥ 1，该 family refresh 再续 401", async () => {
    const creds = await loginForTest(app, "admin", "admin123");

    const r = await injectJson(
      app,
      "POST",
      "/api/auth/logout",
      { refresh_token: creds.refresh_token },
      authHeaders(creds.access_token)
    );
    assert.equal(r.statusCode, 200, `logout failed: ${r.payload}`);
    const body = JSON.parse(r.payload) as { ok: boolean; revoked: number };
    assert.equal(body.ok, true);
    assert.ok(body.revoked >= 1, `revoked 应 ≥ 1，实际 ${body.revoked}`);

    // 再 refresh → 401（已 logout，家族已作废 → reuse/used 逻辑触发 401）
    const r2 = await injectJson(
      app,
      "POST",
      "/api/auth/refresh",
      { refresh_token: creds.refresh_token },
      authHeaders()
    );
    assert.equal(r2.statusCode, 401, `logout 后 refresh 应 401, got ${r2.statusCode}: ${r2.payload}`);
  });
});

// ----------------------------------------------------------------------------
// 8. GET /api/auth/me：返回字段包含 token_version + expires + token_type
// ----------------------------------------------------------------------------
describe("GET /api/auth/me — 当前登录用户信息", () => {
  it("200 含 id/username/nickname/token_type/token_version/expires", async () => {
    const creds = await loginForTest(app, "admin", "admin123");
    const r = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authHeaders(creds.access_token),
    });
    assert.equal(r.statusCode, 200, r.payload);
    const body = JSON.parse(r.payload).data as {
      id: number;
      username: string;
      nickname: string | null;
      token_type: string;
      token_version: number;
      expires: number;
    };
    assert.equal(body.username, "admin");
    assert.equal(body.token_type, "access");
    assert.ok(Number.isFinite(body.token_version) && body.token_version >= 1);
    assert.ok(Number.isFinite(body.expires) && body.expires > Math.floor(Date.now() / 1000));
  });

  it("401: 无 Bearer token → missing bearer token", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authHeaders(), // 不带 token
    });
    assert.equal(r.statusCode, 401);
    assert.match(JSON.parse(r.payload).error, /missing bearer token|invalid token/);
  });
});

// ----------------------------------------------------------------------------
// 专项：users.object_id 用户-项目绑定 + object_table 表白名单
// ----------------------------------------------------------------------------
describe("users.object_id 绑定 + object_table 白名单", () => {
  // 创建临时用户名避免重复；每个 it 使用独立的临时用户
  function randUserName(prefix = "t_user_") {
    return prefix + Math.floor(Math.random() * 1e12).toString(36);
  }

  async function createUserWithBinding(
    username: string,
    object_id: number,
    password = "Temp@12345"
  ): Promise<{ username: string; password: string; id: number }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { "content-type": "application/json", ...(await adminHeaders(app)) },
      payload: JSON.stringify({ username, password, object_id }),
    });
    if (res.statusCode !== 200 && res.statusCode !== 201)
      throw new Error(`createUserWithBinding ${res.statusCode} ${res.payload}`);
    return { username, password, id: JSON.parse(res.payload).id };
  }

  async function deleteUserByName(u: string) {
    const db = getDb();
    const row = db.prepare("SELECT id FROM users WHERE username = ?").get(u) as
      | { id: number }
      | undefined;
    if (row) {
      db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(row.id);
      db.prepare("DELETE FROM users WHERE id = ?").run(row.id);
    }
  }

  it("1. admin(object_id=-1) 可跨任意两个项目访问通用 CRUD 均 200", async () => {
    const objA = await createTestObject(app, {
      name: "tbind_cross_a",
      auth_required: 1,
    });
    const objB = await createTestObject(app, {
      name: "tbind_cross_b",
      auth_required: 1,
    });
    try {
      const token = (await loginForTest(app, "admin", "admin123")).access_token;
      // admin.object_id == -1 系统管理员，放行全部项目
      const rA = await app.inject({
        method: "GET",
        url: `/api/${objA.name}/posts?nopage=1`,
        headers: authHeaders(token),
      });
      assert.equal(rA.statusCode, 200, `A: ${rA.payload}`);

      const rB = await app.inject({
        method: "GET",
        url: `/api/${objB.name}/posts?nopage=1`,
        headers: authHeaders(token),
      });
      assert.equal(rB.statusCode, 200, `B: ${rB.payload}`);
    } finally {
      await deleteTestObject(app, objA.id);
      await deleteTestObject(app, objB.id);
    }
  });

  it("2. 绑定用户：仅该 object 下白名单表 200；跨项目访问 403", async () => {
    const objA = await createTestObject(app, {
      name: "tbind_only_a",
      auth_required: 1,
    });
    const objB = await createTestObject(app, {
      name: "tbind_only_b",
      auth_required: 1,
    });
    const u = randUserName();
    try {
      await createUserWithBinding(u, objA.id);
      const { access_token: tok } = await loginForTest(app, u, "Temp@12345");

      // 访问自己绑定的项目 → 200
      const rA = await app.inject({
        method: "GET",
        url: `/api/${objA.name}/posts?nopage=1`,
        headers: authHeaders(tok),
      });
      assert.equal(rA.statusCode, 200, `self object A: ${rA.payload}`);

      // 跨项目访问 objB → 403 "绑定不符"
      const rB = await app.inject({
        method: "GET",
        url: `/api/${objB.name}/posts?nopage=1`,
        headers: authHeaders(tok),
      });
      assert.equal(rB.statusCode, 403, `cross object B should 403: ${rB.payload}`);
      assert.match(
        JSON.parse(rB.payload).error,
        /无权访问项目|绑定到项目/
      );
    } finally {
      deleteUserByName(u);
      await deleteTestObject(app, objA.id);
      await deleteTestObject(app, objB.id);
    }
  });

  it("3. 表白名单：object_table 已有 ≥1 行时，访问未声明表名 → 403", async () => {
    const obj = await createTestObject(app, { name: "tbl_wl_test" });
    try {
      // 写 1 条规则（posts 表白名单化）—— 从这一刻起表白名单生效，未声明表 403
      await createTableRule(app, obj.id, { table_name: "posts" });

      // posts 已声明，应当 200
      const postsR = await app.inject({
        method: "GET",
        url: `/api/${obj.name}/posts?nopage=1`,
      });
      assert.equal(postsR.statusCode, 200, postsR.payload);

      // random_table_xxx 未声明 → 403 白名单
      const missR = await app.inject({
        method: "GET",
        url: `/api/${obj.name}/random_never_declared_table`,
      });
      assert.equal(missR.statusCode, 403, missR.payload);
      assert.match(
        JSON.parse(missR.payload).error,
        /未在 object_table 中设置访问权限|未声明白名单/
      );
    } finally {
      await deleteTestObject(app, obj.id);
    }
  });

  it("4a. object_id=0 账号 + 正确密码 → 403（未分配项目/禁用，密码正确也拒发 token）", async () => {
    const u = randUserName("t_noobj_");
    try {
      await createUserWithBinding(u, 0);
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: {
          "content-type": "application/json",
          "x-client-id": "test-client",
        },
        payload: JSON.stringify({ username: u, password: "Temp@12345" }),
      });
      assert.equal(res.statusCode, 403, res.payload);
      // 消息可能是 "未分配项目" 或 "已被禁用"，匹配更广的模式
      assert.match(JSON.parse(res.payload).error, /(项目|禁用|不可用)/);
      // 未签发 token
      assert.equal(JSON.parse(res.payload).data, undefined);
    } finally {
      deleteUserByName(u);
    }
  });

  it("4b. object_id=0 账号 + 错误密码 → 401 用户名或密码错误（不泄露账号状态）", async () => {
    const u = randUserName("t_noobj_badpw_");
    try {
      await createUserWithBinding(u, 0);
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: {
          "content-type": "application/json",
          "x-client-id": "test-client",
        },
        payload: JSON.stringify({ username: u, password: "wrong-password" }),
      });
      assert.equal(res.statusCode, 401, res.payload);
      assert.match(JSON.parse(res.payload).error, /用户名或密码错误/);
    } finally {
      deleteUserByName(u);
    }
  });

  it("5. 管理员改用户 object_id 后 → 旧 token 立即 401 revoked，重登后新 JWT 绑定新 object_id", async () => {
    const objA = await createTestObject(app, { name: "tv_bump_a" });
    const objB = await createTestObject(app, { name: "tv_bump_b" });
    const u = randUserName("t_tvbump_");
    try {
      // 创建用户绑定到 objA
      const user = await createUserWithBinding(u, objA.id);
      const firstLogin = await loginForTest(app, u, "Temp@12345");
      const oldTok = firstLogin.access_token;
      // 校验：decodeToken().object_id == objA.id
      assert.equal(
        (decodeToken(oldTok) as { object_id: number }).object_id,
        objA.id
      );

      // 管理员 PATCH 用户 → 绑定改成 objB
      const patchR = await app.inject({
        method: "PATCH",
        url: `/api/users/${user.id}`,
        headers: {
          "content-type": "application/json",
          ...(await adminHeaders(app)),
        },
        payload: JSON.stringify({ object_id: objB.id }),
      });
      assert.equal(patchR.statusCode, 200, patchR.payload);

      // 旧 token /me → 401 revoked（TV bumped，旧 token.tv < users.tv）
      const meOld = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: authHeaders(oldTok),
      });
      assert.equal(meOld.statusCode, 401, `old token should 401: ${meOld.payload}`);

      // 重新登录 → 返回新 token，object_id 已经是 objB.id
      const { access_token: newTok } = await loginForTest(app, u, "Temp@12345");
      assert.equal(
        (decodeToken(newTok) as { object_id: number }).object_id,
        objB.id
      );
    } finally {
      deleteUserByName(u);
      await deleteTestObject(app, objA.id);
      await deleteTestObject(app, objB.id);
    }
  });

  it("6. 管理端 POST /api/config/objects：匿名 401，绑定用户 403，sysadmin 201", async () => {
    // (a) 匿名 → 401 "missing bearer token (sysadmin required)"
    const anonR = await injectJson(app, "POST", "/api/config/objects", {
      name: "tt_gate_anon",
      db_type: "sqlite",
    });
    assert.equal(anonR.statusCode, 401, anonR.payload);
    assert.match(JSON.parse(anonR.payload).error, /sysadmin required|missing bearer/);

    // (b) 绑定用户 token（非 -1）→ 403
    const objForBound = await createTestObject(app, { name: "tt_gate_bound_obj" });
    const u = randUserName("t_gateuser_");
    const createdIdsToClean: number[] = [];
    try {
      await createUserWithBinding(u, objForBound.id);
      const tok = (await loginForTest(app, u, "Temp@12345")).access_token;

      const bindR = await injectJson(
        app,
        "POST",
        "/api/config/objects",
        { name: "tt_gate_user", db_type: "sqlite" },
        authHeaders(tok)
      );
      assert.equal(bindR.statusCode, 403, bindR.payload);
      assert.match(JSON.parse(bindR.payload).error, /sysadmin required|需要系统管理员/);

      // (c) admin token → 201
      const adminR = await injectJson(
        app,
        "POST",
        "/api/config/objects",
        { name: "tt_gate_admin_" + Math.random().toString(36).slice(2, 7), db_type: "sqlite", db_path: APP_DB_PATH },
        await adminHeaders(app)
      );
      assert.equal(adminR.statusCode, 201, adminR.payload);
      createdIdsToClean.push(JSON.parse(adminR.payload).id);
    } finally {
      deleteUserByName(u);
      for (const id of createdIdsToClean) {
        await deleteTestObject(app, id);
      }
      await deleteTestObject(app, objForBound.id);
    }
  });
});
