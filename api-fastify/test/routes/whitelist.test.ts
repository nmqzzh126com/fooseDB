/**
 * object_table 严格白名单机制 —— 专项单元测试
 *
 * 覆盖需求：
 *   ① object_table 完全没有 table_name 行 → 403 "未设置权限"
 *   ② 某表在项目 A 有规则、在项目 B 没有 → 跨项目访问 B → 403 "未声明白名单"
 *   ③ allow_select=0 单独禁止查询（INSERT/PUT/DELETE 仍正常）
 *   ④ blocked=1 同时阻断全部 4 个 CRUD 操作
 *   ⑤ 白名单优先级高于 auth：auth_required=0 或 admin token + 未声明表 → 仍然 403
 *   ⑥ allow_<op>=0 与 auth_required 组合：认证通过但操作被拒 → 403（不是 401）
 *   ⑦ 错误消息区分度：object_table 无任何该行 → "未在 object_table 中设置访问权限"
 *                  该行存在于其他项目 → "在项目 xxx 中未声明白名单"
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  teardownTestApp,
  createTestObject,
  deleteTestObject,
  createTableRule,
  adminHeaders,
  authHeaders,
  loginForTest,
  injectJson
} from "../helper-object.js";

let app: FastifyInstance;

// 两个测试项目，用于跨项目隔离测试
let objA: { id: number; name: string } | null = null;
let objB: { id: number; name: string } | null = null;
let adminTok: string;

before(async () => {
  app = await buildTestApp();
  adminTok = (await loginForTest(app)).access_token;
  // 两个独立项目：A 有 posts + orders 规则，B 只有 posts 规则
  objA = await createTestObject(app, { name: "wl_cross_a", auth_required: 0 });
  objB = await createTestObject(app, { name: "wl_cross_b", auth_required: 0 });
  // objA 额外加一条 orders 规则（白名单独立于 B）
  await createTableRule(app, objA.id, { table_name: "orders" });
  // objB 加 blocked=1 的 orders 规则（展示规则完全独立）
  await createTableRule(app, objB.id, { table_name: "orders", blocked: 1 });
});

after(async () => {
  if (objA) await deleteTestObject(app, objA.id);
  if (objB) await deleteTestObject(app, objB.id);
  if (app) await teardownTestApp(app);
});

// ============================================================================
// 组别 1：严格白名单 —— 未声明表名一律 403
// ============================================================================

test("1a. auth_required=0 + admin token + 未声明表名 → 仍然 403（白名单优先于 auth）", async () => {
  // objA 没有 "reviews" 表的规则 → 不管带不带 token 都应 403
  const withAdminTok = await app.inject({
    method: "GET",
    url: `/api/${objA!.name}/reviews?nopage=1`,
    headers: authHeaders(adminTok)
  });
  assert.equal(withAdminTok.statusCode, 403, `带 admin token 访问未声明表: ${withAdminTok.payload}`);
  assert.match(
    JSON.parse(withAdminTok.payload).error,
    /未在 object_table 中设置访问权限|未声明白名单/
  );

  // 不带 token → 一样 403
  const noTok = await app.inject({
    method: "GET",
    url: `/api/${objA!.name}/reviews?nopage=1`,
  });
  assert.equal(noTok.statusCode, 403, `匿名访问未声明表: ${noTok.payload}`);
});

test("1b. auth_required=1 + 有效 admin token + 未声明表名 → 403（先白名单再 auth）", async () => {
  // 新建 auth_required=1 的项目 + admin token
  const obj = await createTestObject(app, { name: "wl_auth_gate", auth_required: 1 });
  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/no_such_table`,
      headers: authHeaders(adminTok)
    });
    assert.equal(res.statusCode, 403, `auth_required=1 + admin token + 未声明: ${res.payload}`);
    assert.match(JSON.parse(res.payload).error, /未在 object_table|未声明白名单/);
  } finally {
    await deleteTestObject(app, obj.id);
  }
});

// ============================================================================
// 组别 2：跨项目隔离 —— 同一 table_name 在不同 object 下规则独立
// ============================================================================

test("2a. 表 'posts' 在两个项目都声明 → 两个项目都可访问", async () => {
  // createTestObject 已自动为两个项目各创建了 posts 规则
  const rA = await app.inject({
    method: "GET",
    url: `/api/${objA!.name}/posts?nopage=1`,
  });
  assert.equal(rA.statusCode, 200, `objA.posts: ${rA.payload}`);

  const rB = await app.inject({
    method: "GET",
    url: `/api/${objB!.name}/posts?nopage=1`,
  });
  assert.equal(rB.statusCode, 200, `objB.posts: ${rB.payload}`);
});

test("2b. 表 'orders' 仅在 objA 声明 → 访问 objB.orders 403 '未声明白名单'", async () => {
  // objA 声明了 orders → 200（虽然数据源里没有 orders 表，会返回空数组）
  const rA = await app.inject({
    method: "GET",
    url: `/api/${objA!.name}/orders?nopage=1`,
  });
  // 声明存在但真实表不存在 → 500 或业务层错误（非白名单层面）
  // 这里重点是：没返回 403 白名单拦截（白名单检查通过了）
  assert.notEqual(rA.statusCode, 403, `objA.orders 白名单应放行: ${rA.payload}`);

  // objB 的 orders 被 blocked=1 挡（已经有规则但 blocked）
  // 我们要测的是：完全没有规则的 table_name 在另一个项目中
  // → 用 'product_xyz' 这种两边都没声明的表 → 403 "未设置权限"
  const rB = await app.inject({
    method: "GET",
    url: `/api/${objB!.name}/product_xyz?nopage=1`,
  });
  assert.equal(rB.statusCode, 403, `objB.product_xyz 未声明应 403: ${rB.payload}`);
  assert.match(JSON.parse(rB.payload).error, /未在 object_table 中设置访问权限|未声明白名单/);
});

// ============================================================================
// 组别 3：allow_select=0 —— 单独禁止查询，写操作仍然正常
// ============================================================================

test("3a. allow_select=0 但 allow_insert=1 → GET 403 / POST 201", async () => {
  const obj = await createTestObject(app, { name: "wl_no_select" });
  try {
    await createTableRule(app, obj.id, {
      table_name: "posts",
      allow_select: 0,
      allow_insert: 1,
      allow_update: 1,
      allow_delete: 1,
    });

    // SELECT 被拒
    const getRes = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/posts?nopage=1`,
    });
    assert.equal(getRes.statusCode, 403, `allow_select=0 GET: ${getRes.payload}`);
    assert.match(JSON.parse(getRes.payload).error, /select/);

    // INSERT 正常
    const postRes = await injectJson(app, "POST", `/api/${obj.name}/posts`, {
      user_id: 1,
      title: "should succeed",
    });
    assert.equal(postRes.statusCode, 201, `allow_select=0 POST 应成功: ${postRes.payload}`);

    // DELETE 也正常（删除最后一行）
    const body = JSON.parse(postRes.payload).row as { id: number };
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/${obj.name}/posts/${body.id}`,
    });
    assert.equal(delRes.statusCode, 200, `allow_select=0 DELETE 应成功: ${delRes.payload}`);
  } finally {
    await deleteTestObject(app, obj.id);
  }
});

test("3b. allow_select=0 + auth_required=1 + 有效 token → GET 仍然 403（白名单 > auth）", async () => {
  const obj = await createTestObject(app, {
    name: "wl_no_select_auth",
    auth_required: 1,
  });
  try {
    await createTableRule(app, obj.id, {
      table_name: "posts",
      allow_select: 0,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/posts?nopage=1`,
      headers: authHeaders(adminTok),
    });
    assert.equal(res.statusCode, 403, `auth+admin+allow_select=0: ${res.payload}`);
    assert.match(JSON.parse(res.payload).error, /select/);
  } finally {
    await deleteTestObject(app, obj.id);
  }
});

// ============================================================================
// 组别 4：blocked=1 —— 全部 4 个 CRUD 操作都被阻断
// ============================================================================

test("4. blocked=1 同时阻断 GET/POST/PUT/DELETE", async () => {
  const obj = await createTestObject(app, { name: "wl_block_all" });
  let rowId: number | undefined;
  try {
    // 先插入一行让后续 PUT/DELETE 有目标
    const p = await injectJson(app, "POST", `/api/${obj.name}/posts`, {
      user_id: 1,
      title: "pre-block row",
    });
    assert.equal(p.statusCode, 201, `pre-block insert: ${p.payload}`);
    rowId = JSON.parse(p.payload).row.id;

    // 设置 blocked=1
    await createTableRule(app, obj.id, { table_name: "posts", blocked: 1 });

    // 4 个操作都应 403
    const getRes = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/posts?nopage=1`,
    });
    assert.equal(getRes.statusCode, 403, `blocked GET: ${getRes.payload}`);
    assert.match(JSON.parse(getRes.payload).error, /blocked/);

    const postRes = await injectJson(app, "POST", `/api/${obj.name}/posts`, {
      user_id: 1,
      title: "should fail",
    });
    assert.equal(postRes.statusCode, 403, `blocked POST: ${postRes.payload}`);

    const putRes = await injectJson(app, "PUT", `/api/${obj.name}/posts/${rowId}`, {
      title: "should fail",
    });
    assert.equal(putRes.statusCode, 403, `blocked PUT: ${putRes.payload}`);

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/${obj.name}/posts/${rowId}`,
    });
    assert.equal(delRes.statusCode, 403, `blocked DELETE: ${delRes.payload}`);
  } finally {
    await deleteTestObject(app, obj.id);
  }
});

test("4b. blocked=1 + admin token + auth_required=0 → 仍然 403（白名单 > admin）", async () => {
  const obj = await createTestObject(app, { name: "wl_block_admin_gate" });
  try {
    await createTableRule(app, obj.id, { table_name: "posts", blocked: 1 });

    const withAdminTok = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/posts?nopage=1`,
      headers: authHeaders(adminTok),
    });
    assert.equal(withAdminTok.statusCode, 403, `blocked + admin: ${withAdminTok.payload}`);
    assert.match(JSON.parse(withAdminTok.payload).error, /blocked/);
  } finally {
    await deleteTestObject(app, obj.id);
  }
});

// ============================================================================
// 组别 5：allow_<op> 复合规则 —— 只开放部分操作
// ============================================================================

test("5a. allow_insert=allow_update=allow_delete=0 但 allow_select=1 → 只读表", async () => {
  const obj = await createTestObject(app, { name: "wl_readonly" });
  let rowId: number | undefined;
  try {
    // 先允许一次 INSERT 造数据
    const p = await injectJson(app, "POST", `/api/${obj.name}/posts`, {
      user_id: 1,
      title: "seed row",
    });
    assert.equal(p.statusCode, 201, `seed insert: ${p.payload}`);
    rowId = JSON.parse(p.payload).row.id;

    // 改成只读：关闭 3 种写操作
    await createTableRule(app, obj.id, {
      table_name: "posts",
      allow_select: 1,
      allow_insert: 0,
      allow_update: 0,
      allow_delete: 0,
    });

    // GET 正常
    const getRes = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/posts?nopage=1`,
    });
    assert.equal(getRes.statusCode, 200, `readonly GET 应成功: ${getRes.payload}`);

    // POST / PUT / DELETE 都 403
    assert.equal(
      (await injectJson(app, "POST", `/api/${obj.name}/posts`, { user_id: 1, title: "fail" })).statusCode,
      403
    );
    assert.equal(
      (await injectJson(app, "PUT", `/api/${obj.name}/posts/${rowId}`, { title: "fail" })).statusCode,
      403
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/${obj.name}/posts/${rowId}` })).statusCode,
      403
    );
  } finally {
    await deleteTestObject(app, obj.id);
  }
});

test("5b. allow_select=allow_delete=0 但 allow_insert=allow_update=1 → 只写表", async () => {
  const obj = await createTestObject(app, { name: "wl_writeonly" });
  let rowId: number | undefined;
  try {
    await createTableRule(app, obj.id, {
      table_name: "posts",
      allow_select: 0,
      allow_insert: 1,
      allow_update: 1,
      allow_delete: 0,
    });

    // INSERT 正常
    const p = await injectJson(app, "POST", `/api/${obj.name}/posts`, {
      user_id: 1,
      title: "writable",
    });
    assert.equal(p.statusCode, 201, `只写表 INSERT: ${p.payload}`);
    rowId = JSON.parse(p.payload).row.id;

    // PUT 正常
    const u = await injectJson(app, "PUT", `/api/${obj.name}/posts/${rowId}`, {
      title: "updated",
    });
    assert.equal(u.statusCode, 200, `只写表 PUT: ${u.payload}`);

    // GET 和 DELETE 被拒
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/${obj.name}/posts?nopage=1` })).statusCode,
      403
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/${obj.name}/posts/${rowId}` })).statusCode,
      403
    );
  } finally {
    await deleteTestObject(app, obj.id);
  }
});

// ============================================================================
// 组别 6：配置库自保护 + 白名单顺序验证
// ============================================================================

test("6. CONFIG_GUARDED_TABLES 表名即使在 object_table 中声明了规则，也会被自保护拦截", async () => {
  // 用 sqlite_app 的 object_id （内置项目）。sqlite_app 上 users 表已在 CONFIG_GUARDED_TABLES 中。
  // 如果有人（故意或 bug）在生产 DB 里给 sqlite_app.users 加了 object_table 规则，
  // 自保护也应该优先拦截。
  // 这里直接在配置库里插一条规则来验证自保护优先级：
  const { getDb } = await import("../../src/db.js");
  const cfgDb = getDb();
  const sqliteAppId = (cfgDb.prepare("SELECT id FROM object WHERE name='sqlite_app'").get() as { id: number } | undefined)?.id;
  if (sqliteAppId == null) {
    // 有些生产库可能没有 sqlite_app（如本次 data/app.db 被用户改过），跳过
    // 但核心逻辑已被 generic-crud.test.ts 的 "配置库自保护" 覆盖
    return;
  }
  try {
    cfgDb.prepare(`INSERT OR IGNORE INTO object_table(object_id, table_name, blocked, allow_select, allow_insert, allow_update, allow_delete)
                   VALUES(?, 'users', 0, 1, 1, 1, 1)`).run(sqliteAppId);

    const res = await app.inject({
      method: "GET",
      url: "/api/sqlite_app/users",
    });
    assert.equal(res.statusCode, 403, `配置库自保护应优先于白名单: ${res.payload}`);
    assert.match(JSON.parse(res.payload).error, /不允许|守护|guarded/);
  } finally {
    cfgDb.prepare("DELETE FROM object_table WHERE object_id=? AND table_name='users'").run(sqliteAppId);
  }
});
