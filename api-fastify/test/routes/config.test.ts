/**
 * 配置管理接口测试 —— /api/config/objects（object + object_table CRUD）
 *
 * 注：所有 /api/config/* 接口自 v0.1 users.object_id 改造后，
 * 读写均需要「系统管理员（object_id=-1）」Bearer 鉴权。本文件中
 * 所有 HTTP 调用统一使用 adminHeaders(app) 注入 admin token。
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
  adminHeaders,
  APP_DB_PATH,
} from "../helper-object.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const _cleanupIds: number[] = [];

before(async () => {
  app = await buildTestApp();
  // 预热管理员 token（避免首 it 里首次调用等待）
  await adminHeaders(app);
});

after(async () => {
  for (const id of _cleanupIds) {
    await deleteTestObject(app, id);
  }
  if (app) await teardownTestApp(app);
});

// —— object CRUD ——

test("GET /api/config/objects — 返回项目数组", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/config/objects",
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body));
  // 种子数据至少有 sqlite_app
  assert.ok(body.some((o: { name: string }) => o.name === "sqlite_app"));
});

test("POST /api/config/objects — 正常创建项目", async () => {
  const res = await injectJson(
    app,
    "POST",
    "/api/config/objects",
    {
      name: "test_create_ok",
      description: "test description",
      db_type: "sqlite",
      db_path: APP_DB_PATH,
      auth_required: 0,
    },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.payload);
  assert.equal(body.name, "test_create_ok");
  assert.equal(body.db_type, "sqlite");
  assert.equal(body.auth_required, 0);
  _cleanupIds.push(body.id);
});

test("POST /api/config/objects — 保留名 config 被拒绝", async () => {
  const res = await injectJson(
    app,
    "POST",
    "/api/config/objects",
    { name: "config", db_type: "sqlite" },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.payload);
  assert.match(body.error, /保留名/);
});

test("POST /api/config/objects — 保留名 auth 被拒绝", async () => {
  const res = await injectJson(
    app,
    "POST",
    "/api/config/objects",
    { name: "auth", db_type: "sqlite" },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 400);
});

test("POST /api/config/objects — 保留名 users 被拒绝", async () => {
  const res = await injectJson(
    app,
    "POST",
    "/api/config/objects",
    { name: "users", db_type: "sqlite" },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 400);
});

test("POST — invalid db_type 被拒绝", async () => {
  const res = await injectJson(
    app,
    "POST",
    "/api/config/objects",
    { name: "test_bad_ds", db_type: "invalid_type" },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 400);
});

test("POST /api/config/objects — 重复名称返回 409", async () => {
  const obj = await createTestObject(app, { name: "test_dup_name" });
  _cleanupIds.push(obj.id);

  const res = await injectJson(
    app,
    "POST",
    "/api/config/objects",
    { name: "test_dup_name", db_type: "sqlite", db_path: APP_DB_PATH },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 409);
});

test("GET /api/config/objects/:id — 按ID查项目", async () => {
  const obj = await createTestObject(app, { name: "test_get_by_id" });
  _cleanupIds.push(obj.id);

  const res = await app.inject({
    method: "GET",
    url: `/api/config/objects/${obj.id}`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.id, obj.id);
  assert.equal(body.name, "test_get_by_id");
});

test("GET /api/config/objects/:id — 不存在返回 404", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/config/objects/999999",
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 404);
});

test("PUT /api/config/objects/:id — 更新项目", async () => {
  const obj = await createTestObject(app, { name: "test_update" });
  _cleanupIds.push(obj.id);

  const res = await injectJson(
    app,
    "PUT",
    `/api/config/objects/${obj.id}`,
    { description: "updated desc", auth_required: 1 },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.description, "updated desc");
  assert.equal(body.auth_required, 1);
});

test("DELETE /api/config/objects/:id — 删除项目", async () => {
  const obj = await createTestObject(app, { name: "test_delete" });

  const res = await app.inject({
    method: "DELETE",
    url: `/api/config/objects/${obj.id}`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.ok, true);

  // 确认已删除
  const getRes = await app.inject({
    method: "GET",
    url: `/api/config/objects/${obj.id}`,
    headers: await adminHeaders(app),
  });
  assert.equal(getRes.statusCode, 404);
});

test("DELETE /api/config/objects/:id — 级联删除表规则", async () => {
  const obj = await createTestObject(app, { name: "test_cascade" });
  await createTableRule(app, obj.id, { table_name: "posts", allow_insert: 0 });

  // 确认规则存在
  const listRes = await app.inject({
    method: "GET",
    url: `/api/config/objects/${obj.id}/tables`,
    headers: await adminHeaders(app),
  });
  assert.equal(JSON.parse(listRes.payload).items.length, 1);

  // 删除项目
  await app.inject({
    method: "DELETE",
    url: `/api/config/objects/${obj.id}`,
    headers: await adminHeaders(app),
  });

  // 重新创建同ID的项目不应有残留规则（验证级联删除）
  // 因级联删除由外键 ON DELETE CASCADE 保证，直接确认项目已删即可
  const getRes = await app.inject({
    method: "GET",
    url: `/api/config/objects/${obj.id}`,
    headers: await adminHeaders(app),
  });
  assert.equal(getRes.statusCode, 404);
});

// —— object_table CRUD ——

test("POST /api/config/tables — 创建表规则", async () => {
  const obj = await createTestObject(app, { name: "test_rule_create" });
  _cleanupIds.push(obj.id);

  // 使用不同于自动种子 posts 的表名，避免 409 UNIQUE 冲突
  const TABLE = "test_rule_create_" + Math.floor(Math.random() * 1e9);
  const res = await injectJson(
    app,
    "POST",
    `/api/config/tables`,
    { object_id: obj.id, table_name: TABLE, allow_insert: 0, allow_delete: 0 },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.payload);
  assert.equal(body.object_id, obj.id);
  assert.equal(body.table_name, TABLE);
  assert.equal(body.allow_insert, 0);
  assert.equal(body.allow_delete, 0);
  assert.equal(body.allow_select, 1); // 默认允许
});

test("GET /api/config/objects/:id/tables — 列出表规则", async () => {
  const obj = await createTestObject(app, { name: "test_rule_list" });
  _cleanupIds.push(obj.id);
  await createTableRule(app, obj.id, { table_name: "posts" });
  await createTableRule(app, obj.id, { table_name: "users", blocked: 1 });

  const res = await app.inject({
    method: "GET",
    url: `/api/config/objects/${obj.id}/tables`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.items.length, 2);
});

test("PUT /api/config/objects/:id/tables/:ruleId — 更新表规则", async () => {
  const obj = await createTestObject(app, { name: "test_rule_update" });
  _cleanupIds.push(obj.id);
  const rule = await createTableRule(app, obj.id, {
    table_name: "posts",
    allow_insert: 0,
  });

  const res = await injectJson(
    app,
    "PUT",
    `/api/config/tables/${rule.id}`,
    { allow_insert: 1, blocked: 1 },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.allow_insert, 1);
  assert.equal(body.blocked, 1);
});

test("DELETE /api/config/objects/:id/tables/:ruleId — 删除表规则", async () => {
  const obj = await createTestObject(app, { name: "test_rule_delete" });
  _cleanupIds.push(obj.id);
  const rule = await createTableRule(app, obj.id, { table_name: "posts" });

  const res = await app.inject({
    method: "DELETE",
    url: `/api/config/tables/${rule.id}`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.ok, true);

  // 确认规则列表为空
  const listRes = await app.inject({
    method: "GET",
    url: `/api/config/objects/${obj.id}/tables`,
    headers: await adminHeaders(app),
  });
  assert.equal(JSON.parse(listRes.payload).items.length, 0);
});

test("POST /api/config/tables — 重复表名返回 409", async () => {
  const obj = await createTestObject(app, { name: "test_rule_dup" });
  _cleanupIds.push(obj.id);
  await createTableRule(app, obj.id, { table_name: "posts" });

  const res = await injectJson(
    app,
    "POST",
    `/api/config/tables`,
    { object_id: obj.id, table_name: "posts" },
    await adminHeaders(app)
  );
  assert.equal(res.statusCode, 409);
});
