/**
 * 通用 CRUD 查询过滤单元测试（Directus 风格复杂查询）。
 *
 * 覆盖：比较运算符、LIKE 家族、IN/NIN、NULL/NNULL、BETWEEN、
 *       多字段 AND、嵌套 OR、非法列/非法运算符拒绝。
 *
 * 直接用 SQLite 的 app.db，通过 getDb() 临时建一个 products 表
 *   （含自定义字符串主键、各种数据类型列），
 *   跑完后 DROP TABLE 复原，零外部依赖。
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

void describe("通用 CRUD — Directus 风格复杂查询", async () => {
  const app: FastifyInstance = await buildTestApp();
  const obj = await createTestObject(app, "test_filter");
  const TABLE = "test_products_" + Math.floor(Math.random() * 1e9);

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
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
      )
    `);
    const rows: Array<[string, string, string | null, number, number]> = [
      ["P001", "Apple Pie", "draft", 25, 15.5],
      ["P002", "Apple Cake", "paid", 30, 22.0],
      ["P003", "Banana Smoothie", "paid", 45, 8.0],
      ["P004", "Cherry Juice", "cancelled", 18, 12.0],
      ["P005", "Date Nut", "paid", 60, 30.5],
      ["P006", "Plain Bread", null, 0, 5.0],
    ];
    const stmt = db.prepare(
      `INSERT INTO "${TABLE}" (my_id, name, status, qty, price) VALUES (?, ?, ?, ?, ?)`
    );
    for (const r of rows) stmt.run(...r);
  });

  void after(async () => {
    const db = getDb();
    db.exec(`DROP TABLE IF EXISTS "${TABLE}"`);
    await deleteTestObject(app, obj.id);
    await app.close();
  });

  void it("等值查询（默认 _eq，简写）—— status=paid → 3 条", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?status=paid&pageSize=10`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { data: unknown[]; meta: { total: number } };
    assert.equal(body.meta.total, 3);
  });

  void it("_gt 比较运算 —— qty[_gt]=30 → qty 大于 30 的行", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?qty[_gt]=30&pageSize=10`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      data: Array<{ qty: number }>;
      meta: { total: number };
    };
    assert.equal(body.meta.total, 2); // 45 + 60
    for (const r of body.data) assert.ok(r.qty > 30);
  });

  void it("_between —— qty[_between]=20,40 → BETWEEN 20 AND 40", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?qty[_between]=20,40&pageSize=10`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      data: Array<{ qty: number }>;
      meta: { total: number };
    };
    assert.equal(body.meta.total, 2); // 25, 30
    for (const r of body.data) assert.ok(r.qty >= 20 && r.qty <= 40);
  });

  void it("_between 参数个数错误 → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?qty[_between]=20`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /_between/);
  });

  void it("_contains —— name[_contains]=Apple → 两条", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?name[_contains]=Apple&pageSize=10`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      data: Array<{ name: string }>;
      meta: { total: number };
    };
    assert.equal(body.meta.total, 2);
    for (const r of body.data) assert.ok(r.name.includes("Apple"));
  });

  void it("_starts_with + _ends_with", async () => {
    const s = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?name[_starts_with]=Cherry`,
    });
    assert.equal(s.statusCode, 200, s.payload);
    assert.equal(
      (s.json() as { meta: { total: number } }).meta.total,
      1
    );

    const e = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?name[_ends_with]=Cake`,
    });
    assert.equal(e.statusCode, 200, e.payload);
    assert.equal(
      (e.json() as { meta: { total: number } }).meta.total,
      1
    );
  });

  void it("_like 原生通配符（用户自己写 %）—— name[_like]=A% → 两条", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?name[_like]=A%25&pageSize=10`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { meta: { total: number } };
    assert.equal(body.meta.total, 2); // Apple Pie + Apple Cake
  });

  void it("_in —— status[_in]=paid,cancelled → 4 条", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?status[_in]=paid,cancelled&pageSize=10`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { meta: { total: number } };
    assert.equal(body.meta.total, 4);
  });

  void it("_in 空值 → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?status[_in]=`,
    });
    assert.equal(res.statusCode, 400);
  });

  void it("_nin —— status[_nin]=draft,cancelled → 3 条 paid", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?status[_nin]=draft,cancelled&pageSize=10`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      data: Array<{ status: string }>;
      meta: { total: number };
    };
    assert.equal(body.meta.total, 3);
    for (const r of body.data) assert.equal(r.status, "paid");
  });

  void it("多字段 AND：status=paid + qty[_gte]=45 → 两条", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?status=paid&qty[_gte]=45&pageSize=10`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      data: Array<{ status: string; qty: number }>;
      meta: { total: number };
    };
    assert.equal(body.meta.total, 2); // 45 + 60
    for (const r of body.data) {
      assert.equal(r.status, "paid");
      assert.ok(r.qty >= 45);
    }
  });

  void it("_or 分组：(Apple Pie AND qty<30) OR (Banana Smoothie) → 两条", async () => {
    const q = new URLSearchParams({
      "_or[0][name][_eq]": "Apple Pie",
      "_or[0][qty][_lt]": "30",
      "_or[1][name][_eq]": "Banana Smoothie",
      "pageSize": "10",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { meta: { total: number } };
    assert.equal(body.meta.total, 2);
  });

  void it("__one=1 + 复杂条件（getOne 也使用 filter 解析）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?__one=1&qty[_gte]=50`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const row = res.json() as { name: string; qty: number };
    assert.equal(row.name, "Date Nut");
    assert.equal(row.qty, 60);
  });

  void it("__one=1 无条件 → 400（At least one condition required）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?__one=1`,
    });
    assert.equal(res.statusCode, 400);
  });

  void it("非法列名 → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?does_not_exist=1`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /does_not_exist/);
  });

  void it("非法运算符 → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?qty[_evil]=1`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /Invalid filter key/);
  });

  void it("_null + _nnull：status[_null]=1 → 1 条；status[_nnull]=1 → 5 条", async () => {
    const r1 = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?status[_null]=1`,
    });
    assert.equal(r1.statusCode, 200, r1.payload);
    assert.equal(
      (r1.json() as { meta: { total: number } }).meta.total,
      1
    );

    const r2 = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?status[_nnull]=1`,
    });
    assert.equal(r2.statusCode, 200, r2.payload);
    assert.equal(
      (r2.json() as { meta: { total: number } }).meta.total,
      5
    );
  });

  void it("不分页（nopage）使用同过滤：status=paid → 返回数组内 3 条", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?nopage=1&status=paid`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const data = res.json() as Array<{ status: string }>;
    assert.equal(data.length, 3);
  });
});
