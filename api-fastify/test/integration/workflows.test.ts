/**
 * 集成测试 —— 端到端业务流程，串联多个接口验证联动行为。
 *
 * 与单元测试的区别：
 *   - 单元测试：每个用例只验证单个端点的输入/输出
 *   - 集成测试：模拟真实用户操作序列，验证多接口组合后的系统行为
 *
 * 覆盖流程：
 *   1. 项目生命周期 + 表规则动态生效
 *   2. auth 认证开关端到端
 *   3. 完整 CRUD + 多种查询组合
 *   4. CORS + 元数据联动
 *   5. 配置管理全链路（创建→规则→验证→更新→验证→删除→级联）
 */

import "../setup-env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  buildTestApp,
  teardownTestApp,
  injectJson,
  createTestObject,
  deleteTestObject,
  createTableRule,
  loginForTest,
  authHeaders,
  adminHeaders,
} from "../helper-object.js";
import type { FastifyInstance } from "fastify";
import { getDb } from "../../src/db.js";

let app: FastifyInstance;
let token: string;

before(async () => {
  app = await buildTestApp();
  token = (await loginForTest(app)).access_token;
  // 预清理：删除之前失败遗留的、以"int_"开头的测试项目
  // （workflows 用固定名字以便阅读，前几次失败导致 app.db 有残留，产生 409 名称重复）
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM object WHERE name LIKE 'int_%' ESCAPE '\\'")
    .all() as { id: number }[];
  for (const r of rows) {
    try {
      await deleteTestObject(app, r.id);
    } catch {
      // ignore, outer FK cascade handled by after cleanup anyway
    }
  }
});

after(async () => {
  if (app) await teardownTestApp(app);
});

// ====================================================================
// 流程 1：项目生命周期 + 表规则动态生效
// ====================================================================

test("集成：创建项目 → 添加规则 → 验证限制 → 更新规则 → 验证放行 → 删除项目", async () => {
  // 1. 创建项目
  const obj = await createTestObject(app, { name: "int_lifecycle" });
  const base = `/api/${obj.name}`;

  // 2. 无规则时插入成功
  const insertRes = await injectJson(app, "POST", `${base}/posts`, {
    user_id: 1,
    title: "lifecycle row",
    content: "before rule",
  });
  assert.equal(insertRes.statusCode, 201);
  const rowId = JSON.parse(insertRes.payload).id;

  // 3. 添加 allow_insert=0 规则
  const rule = await createTableRule(app, obj.id, {
    table_name: "posts",
    allow_insert: 0,
  });

  // 4. 验证插入被拒绝
  const blockedRes = await injectJson(app, "POST", `${base}/posts`, {
    user_id: 1,
    title: "should fail",
  });
  assert.equal(blockedRes.statusCode, 403);
  assert.match(JSON.parse(blockedRes.payload).error, /insert/);

  // 5. 验证查询仍然允许
  const selectRes = await app.inject({ method: "GET", url: `${base}/posts` });
  assert.equal(selectRes.statusCode, 200);

  // 6. 更新规则：放开 insert，禁止 update
  const updateRuleRes = await injectJson(
    app,
    "PUT",
    `/api/config/tables/${rule.id}`,
    { allow_insert: 1, allow_update: 0 },
    await adminHeaders(app)
  );
  assert.equal(updateRuleRes.statusCode, 200);
  assert.equal(JSON.parse(updateRuleRes.payload).allow_insert, 1);
  assert.equal(JSON.parse(updateRuleRes.payload).allow_update, 0);

  // 7. 验证插入恢复
  const insertOkRes = await injectJson(app, "POST", `${base}/posts`, {
    user_id: 1,
    title: "after rule update",
  });
  assert.equal(insertOkRes.statusCode, 201);

  // 8. 验证更新被拒绝
  const updateBlockedRes = await injectJson(
    app,
    "PUT",
    `${base}/posts/${rowId}`,
    { title: "should fail" }
  );
  assert.equal(updateBlockedRes.statusCode, 403);
  assert.match(JSON.parse(updateBlockedRes.payload).error, /update/);

  // 9. 删除项目 → 级联删除规则
  const delRes = await app.inject({
    method: "DELETE",
    url: `/api/config/objects/${obj.id}`,
    headers: await adminHeaders(app),
  });
  assert.equal(delRes.statusCode, 200);

  // 10. 验证项目已删除
  const getRes = await app.inject({
    method: "GET",
    url: `/api/config/objects/${obj.id}`,
    headers: await adminHeaders(app),
  });
  assert.equal(getRes.statusCode, 404);
});

// ====================================================================
// 流程 2：auth 认证开关端到端
// ====================================================================

test("集成：auth_required 从 0→1→带 token 访问→篡改 token 被拒", async () => {
  // 1. 创建项目，auth_required=0
  const obj = await createTestObject(app, {
    name: "int_auth_toggle",
    auth_required: 0,
  });

  // 2. 无 token 访问 → 200
  const noTokenRes = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
  });
  assert.equal(noTokenRes.statusCode, 200);

  // 3. 开启 auth_required
  const toggleRes = await injectJson(
    app,
    "PUT",
    `/api/config/objects/${obj.id}`,
    { auth_required: 1 },
    await adminHeaders(app)
  );
  assert.equal(toggleRes.statusCode, 200);
  assert.equal(JSON.parse(toggleRes.payload).auth_required, 1);

  // 4. 无 token 访问 → 401
  const blockedRes = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
  });
  assert.equal(blockedRes.statusCode, 401);
  assert.match(JSON.parse(blockedRes.payload).error, /bearer token/);

  // 5. 携带正确 token 访问 → 200
  const withTokenRes = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
    headers: authHeaders(token),
  });
  assert.equal(withTokenRes.statusCode, 200);

  // 6. 携带篡改 token 访问 → 401
  const tamperedToken = token.slice(0, -4) + "AAAA";
  const tamperedRes = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
    headers: authHeaders(tamperedToken),
  });
  assert.equal(tamperedRes.statusCode, 401);

  // 7. 不同客户端指纹的 token → 401
  const otherClientRes = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
    headers: {
      "x-client-id": "different-client",
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(otherClientRes.statusCode, 401);

  // 清理
  await deleteTestObject(app, obj.id);
});

// ====================================================================
// 流程 3：完整 CRUD + 多种查询组合
// ====================================================================

test("集成：插入多行 → 分页查询 → 不分页查询 → 条件查单行 → 按主键查 → 更新 → 删除", async () => {
  const obj = await createTestObject(app, { name: "int_crud_flow" });
  const base = `/api/${obj.name}`;

  // 1. 插入 3 行
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await injectJson(app, "POST", `${base}/posts`, {
      user_id: 1,
      title: `crud_flow_${i}`,
      content: `content ${i}`,
    });
    assert.equal(res.statusCode, 201);
    ids.push(JSON.parse(res.payload).row.id);
  }
  assert.equal(ids.length, 3);

  // 2. 分页查询（第 1 页，pageSize=2）
  const pageRes = await app.inject({
    method: "GET",
    url: `${base}/posts?page=1&pageSize=2`,
  });
  assert.equal(pageRes.statusCode, 200);
  const pageBody = JSON.parse(pageRes.payload);
  assert.ok(pageBody.data.length <= 2);
  assert.ok(pageBody.meta.total >= 3);
  assert.equal(pageBody.meta.page, 1);
  assert.equal(pageBody.meta.pageSize, 2);

  // 3. 不分页查询
  const nopageRes = await app.inject({
    method: "GET",
    url: `${base}/posts?nopage=1`,
  });
  assert.equal(nopageRes.statusCode, 200);
  const nopageBody = JSON.parse(nopageRes.payload);
  assert.ok(Array.isArray(nopageBody));
  assert.ok(nopageBody.length >= 3);

  // 4. 条件查单行（用 title 精确匹配）
  const oneRes = await app.inject({
    method: "GET",
    url: `${base}/posts?__one=1&title=${encodeURIComponent("crud_flow_1")}`,
  });
  assert.equal(oneRes.statusCode, 200);
  const oneBody = JSON.parse(oneRes.payload);
  assert.equal(oneBody.title, "crud_flow_1");

  // 5. 按主键查
  const byIdRes = await app.inject({
    method: "GET",
    url: `${base}/posts/${ids[0]}`,
  });
  assert.equal(byIdRes.statusCode, 200);
  assert.equal(JSON.parse(byIdRes.payload).id, ids[0]);

  // 6. 更新行
  const updateRes = await injectJson(
    app,
    "PUT",
    `${base}/posts/${ids[2]}`,
    { title: "crud_flow_updated", content: "updated content" }
  );
  assert.equal(updateRes.statusCode, 200);
  assert.ok(JSON.parse(updateRes.payload).ok);
  assert.equal(JSON.parse(updateRes.payload).row.title, "crud_flow_updated");

  // 7. 验证更新生效
  const verifyRes = await app.inject({
    method: "GET",
    url: `${base}/posts/${ids[2]}`,
  });
  assert.equal(JSON.parse(verifyRes.payload).title, "crud_flow_updated");

  // 8. 删除行
  const delRes = await app.inject({
    method: "DELETE",
    url: `${base}/posts/${ids[2]}`,
  });
  assert.equal(delRes.statusCode, 200);

  // 9. 验证已删除
  const verifyDelRes = await app.inject({
    method: "GET",
    url: `${base}/posts/${ids[2]}`,
  });
  assert.equal(verifyDelRes.statusCode, 404);

  // 清理：删除插入的剩余行
  for (const id of [ids[0], ids[1]]) {
    await app.inject({ method: "DELETE", url: `${base}/posts/${id}` });
  }
  await deleteTestObject(app, obj.id);
});

// ====================================================================
// 流程 4：CORS + 元数据联动
// ====================================================================

test("集成：创建项目 → CORS 头随 object 存在而生效 → 删除项目 → CORS 头消失", async () => {
  const obj = await createTestObject(app, { name: "int_cors_flow", cors_origins: "*" });
  const origin = "http://localhost:8848";

  // 1. 项目存在时：GET 请求带 Origin → 有 CORS 头
  const res1 = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
    headers: { origin },
  });
  assert.equal(res1.headers["access-control-allow-origin"], origin);

  // 2. OPTIONS 预检 → 204 + CORS 头
  const optRes = await app.inject({
    method: "OPTIONS",
    url: `/api/${obj.name}/posts`,
    headers: { origin, "access-control-request-method": "GET" },
  });
  assert.equal(optRes.statusCode, 204);
  assert.equal(optRes.headers["access-control-allow-origin"], origin);

  // 3. 删除项目
  await deleteTestObject(app, obj.id);

  // 4. 项目不存在后：同一 URL 带 Origin → 无 CORS 头（object 解析失败）
  const res2 = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
    headers: { origin },
  });
  assert.equal(res2.headers["access-control-allow-origin"], undefined);
});

// ====================================================================
// 流程 5：配置管理全链路
// ====================================================================

test("集成：创建项目 → 加规则 → blocked 整表 → PUT blocked=0 恢复 → 最终删除", async () => {
  const obj = await createTestObject(app, { name: "int_config_flow" });
  const base = `/api/${obj.name}`;

  // 1. createTestObject 已自动为 posts 表加全放行规则（严格白名单模式）
  const insert1 = await injectJson(app, "POST", `${base}/posts`, {
    user_id: 1,
    title: "before rule",
  });
  assert.equal(insert1.statusCode, 201);

  // 2. PUT blocked=1（整表禁止）
  const rule = await createTableRule(app, obj.id, {
    table_name: "posts",
    blocked: 1,
  });

  // 3. 验证所有操作被拒
  const selectBlocked = await app.inject({ method: "GET", url: `${base}/posts` });
  assert.equal(selectBlocked.statusCode, 403);
  assert.match(JSON.parse(selectBlocked.payload).error, /blocked/);

  const insertBlocked = await injectJson(app, "POST", `${base}/posts`, {
    user_id: 1,
    title: "blocked",
  });
  assert.equal(insertBlocked.statusCode, 403);

  // 4. 恢复 blocked=0（PUT 更新规则）
  const unblockRes = await injectJson(
    app,
    "PUT",
    `/api/config/tables/${rule.id}`,
    { blocked: 0 },
    await adminHeaders(app)
  );
  assert.equal(unblockRes.statusCode, 200);

  // 5. 验证操作恢复
  const selectOk = await app.inject({ method: "GET", url: `${base}/posts` });
  assert.equal(selectOk.statusCode, 200);

  const insertOk = await injectJson(app, "POST", `${base}/posts`, {
    user_id: 1,
    title: "after unblock",
  });
  assert.equal(insertOk.statusCode, 201);

  // 清理
  await deleteTestObject(app, obj.id);
});

// ====================================================================
// 流程 6：多项目 + 独立规则隔离
// ====================================================================

test("集成：两个项目 → 各自独立规则 → 互不影响", async () => {
  const objA = await createTestObject(app, { name: "int_isolation_a" });
  const objB = await createTestObject(app, { name: "int_isolation_b" });

  // 项目 A 禁止插入 posts
  await createTableRule(app, objA.id, {
    table_name: "posts",
    allow_insert: 0,
  });

  // 项目 B 不加任何规则

  // A 的插入被拒
  const resA = await injectJson(app, "POST", `/api/${objA.name}/posts`, {
    user_id: 1,
    title: "should fail in A",
  });
  assert.equal(resA.statusCode, 403);

  // B 的插入成功
  const resB = await injectJson(app, "POST", `/api/${objB.name}/posts`, {
    user_id: 1,
    title: "should succeed in B",
  });
  assert.equal(resB.statusCode, 201);

  // A 的查询仍然允许（只禁了 insert）
  const selA = await app.inject({
    method: "GET",
    url: `/api/${objA.name}/posts`,
  });
  assert.equal(selA.statusCode, 200);

  // 清理
  await deleteTestObject(app, objA.id);
  await deleteTestObject(app, objB.id);
});

// ====================================================================
// 流程 7：登录 → 获取 token → 访问 /api/auth/me → 访问 auth 项目
// ====================================================================

test("集成：登录 → 验证 token → 访问受保护项目 → 跨项目复用 token", async () => {
  // 1. 登录
  const loginRes = await injectJson(
    app,
    "POST",
    "/api/auth/login",
    { username: "admin", password: "admin123" },
    { "x-client-id": "test-client" }
  );
  assert.equal(loginRes.statusCode, 200);
  const accessToken = JSON.parse(loginRes.payload).data.access_token;

  // 2. 验证 token 有效
  const meRes = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: authHeaders(accessToken),
  });
  assert.equal(meRes.statusCode, 200);
  const meBody = JSON.parse(meRes.payload);
  assert.equal(meBody.data.username, "admin");

  // 3. 创建两个 auth_required=1 的项目
  const objA = await createTestObject(app, {
    name: "int_token_reuse_a",
    auth_required: 1,
  });
  const objB = await createTestObject(app, {
    name: "int_token_reuse_b",
    auth_required: 1,
  });

  // 4. 同一个 token 访问两个项目都成功
  const resA = await app.inject({
    method: "GET",
    url: `/api/${objA.name}/posts`,
    headers: authHeaders(accessToken),
  });
  assert.equal(resA.statusCode, 200);

  const resB = await app.inject({
    method: "GET",
    url: `/api/${objB.name}/posts`,
    headers: authHeaders(accessToken),
  });
  assert.equal(resB.statusCode, 200);

  // 清理
  await deleteTestObject(app, objA.id);
  await deleteTestObject(app, objB.id);
});
