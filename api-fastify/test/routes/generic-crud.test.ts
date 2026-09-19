/**
 * 通用 CRUD 接口 + 访问控制测试 —— /api/:object/:table
 *
 * 覆盖：
 *   - CRUD 七操作（分页/不分页/单行/按主键/插入/更新/删除）
 *   - 访问控制：项目不存在(404)、auth 认证(401/200)、配置库自保护(403)、
 *     表 blocked(403)、操作级禁止(403)
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
} from "../helper-object.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let accessToken: string;
const _cleanupIds: number[] = [];

before(async () => {
  app = await buildTestApp();
  accessToken = (await loginForTest(app)).access_token;
});

after(async () => {
  for (const id of _cleanupIds) {
    await deleteTestObject(app, id);
  }
  if (app) await teardownTestApp(app);
});

// —— helper：插入一行 posts 并返回 id ——

async function insertPost(title: string): Promise<number> {
  const res = await injectJson(
    app,
    "POST",
    "/api/sqlite_app/posts",
    { user_id: 1, title, content: "test content" }
  );
  assert.equal(res.statusCode, 201, `insertPost failed: ${res.payload}`);
  return JSON.parse(res.payload).row.id as number;
}

// ===================== CRUD 操作 =====================

test("GET /api/:object/:table — 分页查询返回 data + meta", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/sqlite_app/posts?page=1&pageSize=5",
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.data));
  assert.ok(body.meta);
  assert.equal(typeof body.meta.total, "number");
  assert.equal(body.meta.page, 1);
  assert.equal(body.meta.pageSize, 5);
});

test("GET /api/:object/:table?nopage=1 — 不分页查询返回数组", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/sqlite_app/posts?nopage=1",
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body));
});

test("GET /api/:object/:table?__one=1 — 按条件查一行", async () => {
  const title = `one_test_${Date.now()}`;
  const id = await insertPost(title);

  const res = await app.inject({
    method: "GET",
    url: `/api/sqlite_app/posts?__one=1&title=${encodeURIComponent(title)}`,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.id, id);
  assert.equal(body.title, title);
});

test("GET /api/:object/:table/:id — 按主键查一行", async () => {
  const id = await insertPost("getbyid_test");

  const res = await app.inject({
    method: "GET",
    url: `/api/sqlite_app/posts/${id}`,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.id, id);
});

test("GET /api/:object/:table/:id — 不存在的主键返回 404", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/sqlite_app/posts/9999999",
  });
  assert.equal(res.statusCode, 404);
});

test("POST /api/:object/:table — 插入行", async () => {
  const res = await injectJson(app, "POST", "/api/sqlite_app/posts", {
    user_id: 1,
    title: "insert_test",
    content: "inserted by test",
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.payload);
  assert.ok(body.ok);
  assert.ok(body.row.id > 0);
});

test("PUT /api/:object/:table/:id — 更新行", async () => {
  const id = await insertPost("update_test_before");

  const res = await injectJson(app, "PUT", `/api/sqlite_app/posts/${id}`, {
    title: "update_test_after",
    content: "updated content",
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(body.ok);
  assert.equal(body.row.id, id);
  assert.equal(body.row.title, "update_test_after");
});

test("DELETE /api/:object/:table/:id — 删除行", async () => {
  const id = await insertPost("delete_test");

  const res = await app.inject({
    method: "DELETE",
    url: `/api/sqlite_app/posts/${id}`,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.ok, true);

  // 确认已删除
  const getRes = await app.inject({
    method: "GET",
    url: `/api/sqlite_app/posts/${id}`,
  });
  assert.equal(getRes.statusCode, 404);
});

// ===================== 访问控制 =====================

test("GET /api/:object/:table — 项目不存在返回 404", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/nonexistent_obj/posts",
  });
  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.payload);
  assert.match(body.error, /不存在/);
});

test("auth_required=1 — 无 token 返回 401", async () => {
  const obj = await createTestObject(app, {
    name: "test_auth_401",
    auth_required: 1,
  });
  _cleanupIds.push(obj.id);

  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
  });
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.payload);
  assert.match(body.error, /bearer token/);
});

test("auth_required=1 — 携带有效 token 返回 200", async () => {
  const obj = await createTestObject(app, {
    name: "test_auth_200",
    auth_required: 1,
  });
  _cleanupIds.push(obj.id);

  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
    headers: authHeaders(accessToken),
  });
  assert.equal(res.statusCode, 200);
});

test("配置库自保护 — object 表禁止通过通用接口访问", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/sqlite_app/object",
  });
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.payload);
  assert.match(body.error, /不允许/);
});

test("配置库自保护 — object_table 表禁止访问", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/sqlite_app/object_table",
  });
  assert.equal(res.statusCode, 403);
});

test("配置库自保护 — users 表禁止访问", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/sqlite_app/users",
  });
  assert.equal(res.statusCode, 403);
});

test("表级限制 — blocked=1 整表禁止访问", async () => {
  const obj = await createTestObject(app, { name: "test_blocked" });
  _cleanupIds.push(obj.id);
  await createTableRule(app, obj.id, { table_name: "posts", blocked: 1 });

  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
  });
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.payload);
  assert.match(body.error, /blocked/);
});

test("表级限制 — allow_insert=0 禁止插入", async () => {
  const obj = await createTestObject(app, { name: "test_no_insert" });
  _cleanupIds.push(obj.id);
  await createTableRule(app, obj.id, { table_name: "posts", allow_insert: 0 });

  const res = await injectJson(app, "POST", `/api/${obj.name}/posts`, {
    user_id: 1,
    title: "should_fail",
  });
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.payload);
  assert.match(body.error, /insert/);
});

test("表级限制 — allow_update=0 禁止更新", async () => {
  const obj = await createTestObject(app, { name: "test_no_update" });
  _cleanupIds.push(obj.id);
  await createTableRule(app, obj.id, { table_name: "posts", allow_update: 0 });

  const res = await injectJson(app, "PUT", `/api/${obj.name}/posts/1`, {
    title: "should_fail",
  });
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.payload);
  assert.match(body.error, /update/);
});

test("表级限制 — allow_delete=0 禁止删除", async () => {
  const obj = await createTestObject(app, { name: "test_no_delete" });
  _cleanupIds.push(obj.id);
  await createTableRule(app, obj.id, { table_name: "posts", allow_delete: 0 });

  const res = await app.inject({
    method: "DELETE",
    url: `/api/${obj.name}/posts/1`,
  });
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.payload);
  assert.match(body.error, /delete/);
});

test("表级限制 — 无规则时全部操作允许", async () => {
  const obj = await createTestObject(app, { name: "test_no_rules" });
  _cleanupIds.push(obj.id);

  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts`,
  });
  assert.equal(res.statusCode, 200);
});
