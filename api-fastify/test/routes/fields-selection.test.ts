/**
 * 自定义返回字段（fields=）端到端测试：
 *   GET /:id、POST、PUT 三个写/查接口都支持 ?fields=a,b,c
 * 默认行为（不传 fields）返回所有列。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  createTestObject,
  createTableRule,
  deleteTestObject,
} from "../helper-object.js";
import { getDb } from "../../src/db.js";

void describe("通用 CRUD — fields 自定义返回字段", async () => {
  const app: FastifyInstance = await buildTestApp();
  const obj = await createTestObject(app, "test_fields");
  const TABLE = "test_fields_" + Math.floor(Math.random() * 1e9);

  void before(async () => {
    await createTableRule(app, obj.id, { table_name: TABLE });
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS "${TABLE}" (
        my_id      TEXT    NOT NULL PRIMARY KEY,
        name       TEXT    NOT NULL,
        status     TEXT,
        qty        INTEGER NOT NULL DEFAULT 0,
        price      REAL,
        cat        TEXT
      )
    `);
    const stmt = db.prepare(
      `INSERT INTO "${TABLE}" (my_id, name, status, qty, price, cat) VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run("X01", "X Item", "paid", 10, 20, "xcat");
  });

  void after(async () => {
    const db = getDb();
    db.exec(`DROP TABLE IF EXISTS "${TABLE}"`);
    await deleteTestObject(app, obj.id);
    await app.close();
  });

  // —— 默认（不传 fields）返回所有列 ——
  void it("默认 GET /:id 返回所有列", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}/X01`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const row = res.json() as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(row).sort(),
      ["cat", "my_id", "name", "price", "qty", "status"]
    );
  });

  void it("GET /:id 传 fields=my_id,name → 仅两列", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}/X01?fields=my_id,name`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const row = res.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), ["my_id", "name"]);
    assert.equal(row.my_id, "X01");
    assert.equal(row.name, "X Item");
  });

  void it("GET /:id fields 不存在列 → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}/X01?fields=my_id,nope_col`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /Unknown column in fields/);
  });

  void it("POST 默认返回所有列", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/${obj.name}/${TABLE}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        my_id: "Y02",
        name: "Y Item",
        status: "draft",
        qty: 5,
        price: 8.5,
        cat: "ycat",
      }),
    });
    assert.equal(res.statusCode, 201, res.payload);
    const { row } = res.json() as { ok: true; row: Record<string, unknown> };
    assert.deepEqual(
      Object.keys(row).sort(),
      ["cat", "my_id", "name", "price", "qty", "status"]
    );
  });

  void it("POST ?fields=my_id,name → 仅返回这两列（自定义字符串主键）", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/${obj.name}/${TABLE}?fields=my_id,name`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        my_id: "Z03",
        name: "Z Item",
        status: "cancelled",
        qty: 1,
        price: 100,
        cat: "zcat",
      }),
    });
    assert.equal(res.statusCode, 201, res.payload);
    const { row } = res.json() as { ok: true; row: Record<string, unknown> };
    const keys = Object.keys(row).sort();
    assert.deepEqual(keys, ["my_id", "name"], `got keys=${JSON.stringify(keys)}, payload=${res.payload}`);
    assert.equal(row.my_id, "Z03");
    assert.equal(row.name, "Z Item");
  });

  void it("POST fields 非法列 → 400（不会插入半条数据，白名单校验在 INSERT 之前执行）", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/${obj.name}/${TABLE}?fields=my_id,bad_col`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        my_id: "FAIL1",
        name: "Should Not Insert",
        status: "paid",
        qty: 0,
        price: 0,
        cat: "f",
      }),
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /Unknown column in fields/);
    // 确认没插入
    const ck = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}/FAIL1`,
    });
    assert.equal(ck.statusCode, 404, "400 时行不应被插入");
  });

  void it("PUT 默认返回所有列 row", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/${obj.name}/${TABLE}/X01`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ qty: 99, price: 999 }),
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      ok: true;
      row: Record<string, unknown>;
    };
    assert.ok(body.ok);
    assert.deepEqual(
      Object.keys(body.row).sort(),
      ["cat", "my_id", "name", "price", "qty", "status"]
    );
    assert.equal(body.row.qty, 99);
  });

  void it("PUT ?fields=my_id,qty → row 仅返回这两列", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/${obj.name}/${TABLE}/X01?fields=my_id,qty`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ qty: 42 }),
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      ok: true;
      row: Record<string, unknown>;
    };
    assert.ok(body.ok);
    assert.deepEqual(Object.keys(body.row).sort(), ["my_id", "qty"]);
    assert.equal(body.row.my_id, "X01");
    assert.equal(body.row.qty, 42);
  });

  void it("PUT fields 非法列 → 400，行未被更新", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/${obj.name}/${TABLE}/X01?fields=my_id,nope`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ qty: 123456 }),
    });
    assert.equal(res.statusCode, 400, res.payload);
    // 确认没更新：qty 仍是上一步写入的 42
    const ck = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}/X01?fields=qty`,
    });
    assert.equal(ck.json().qty, 42);
  });

  void it("分页查询 ?fields=my_id,name → data 仅两列（list 已支持，回归验证）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?fields=my_id,name&pageSize=10&orderBy=my_id:asc`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { data: Array<Record<string, unknown>> };
    assert.ok(body.data.length >= 2);
    for (const r of body.data) {
      assert.deepEqual(Object.keys(r).sort(), ["my_id", "name"]);
    }
  });

  void it("不分页查询 ?fields=my_id,status → data 仅两列", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?nopage=1&fields=my_id,status`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<Record<string, unknown>>;
    for (const r of rows) {
      assert.deepEqual(Object.keys(r).sort(), ["my_id", "status"]);
    }
  });
});
