/**
 * CORS 插件测试 —— 按 object 名解析数据源 CORS 策略
 *
 * 覆盖：
 *   - object 存在 + Origin 匹配 → CORS 头
 *   - object 存在 + 无 Origin → 无 CORS 头
 *   - OPTIONS 预检 → 204 + CORS 头
 *   - object 不存在 → 无 CORS 头
 *   - 非对象路径（/api/users 无尾斜杠）→ 无 CORS 头
 */

import "../setup-env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, teardownTestApp } from "../helper-object.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

before(async () => {
  app = await buildTestApp();
});

after(async () => {
  if (app) await teardownTestApp(app);
});

test("GET /api/:object/:table + Origin → 包含 CORS 响应头", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/sqlite_app/posts",
    headers: { origin: "http://localhost:8848" },
  });
  assert.equal(res.statusCode, 200);
  // sqlite_app 的 CORS_ORIGINS=*，所有 Origin 都匹配
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:8848");
  assert.ok(res.headers["access-control-allow-methods"]);
  assert.equal(res.headers["access-control-allow-credentials"], "true");
});

test("GET /api/:object/:table 无 Origin → 不设 CORS 头", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/sqlite_app/posts",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("OPTIONS 预检 /api/:object/:table → 204 + CORS 头", async () => {
  const res = await app.inject({
    method: "OPTIONS",
    url: "/api/sqlite_app/posts",
    headers: {
      origin: "http://localhost:8848",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:8848");
  assert.ok(res.headers["access-control-allow-methods"]);
  assert.equal(res.headers["access-control-max-age"], "86400");
});

test("GET /api/nonexistent/:table + Origin → 无 CORS 头（对象不存在）", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/nonexistent_cors_test/posts",
    headers: { origin: "http://localhost:8848" },
  });
  // 路由会给 404，但 CORS 头不应存在（对象不在 object 表中）
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("GET /api/users（无尾斜杠，非对象路径）→ 有 CORS 头（admin 全局兜底）", async () => {
  // /api/users 属于管理端路径，走 ADMIN_CORS_ORIGINS 全局兜底（默认 *）
  const res = await app.inject({
    method: "GET",
    url: "/api/users",
    headers: { origin: "http://localhost:8848" },
  });
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:8848");
});

test("GET /api/config/objects + Origin → 有 CORS 头（admin 全局兜底）", async () => {
  // /api/config/* 管理端路径走 ADMIN_CORS_ORIGINS 全局兜底（默认 *）
  const res = await app.inject({
    method: "GET",
    url: "/api/config/objects",
    headers: { origin: "http://localhost:8848" },
  });
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:8848");
});
