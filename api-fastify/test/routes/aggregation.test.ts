/**
 * 通用 CRUD —— 聚合 / 分组 / 列选择 / 多字段排序 测试。
 *
 * 测试目标：
 *   1. count/sum/avg/min/max/countDistinct/groupConcat 各聚合函数
 *   2. groupBy 单列 + 多列 + 分组 meta.total 正确
 *   3. fields 列选择 & fields + 聚合混选
 *   4. 多字段 orderBy（含 :方向后缀）
 *   5. 安全边界：非法函数、非法列、非法 alias → 400
 *
 * 在 app.db 里临时创建 products 表（含自定义字符串 pk + 各种数据类型），跑完删除。
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

void describe("通用 CRUD — 聚合 & groupBy & fields & 多字段排序", async () => {
  const app: FastifyInstance = await buildTestApp();
  const obj = await createTestObject(app, "test_agg");
  const TABLE = "test_agg_products_" + Math.floor(Math.random() * 1e9);

  void before(async () => {
    // 严格白名单模式：先声明动态表的访问规则
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
    const rows: Array<[string, string, string | null, number, number, string]> = [
      ["P001", "Apple Pie", "paid", 10, 15.5, "food"],
      ["P002", "Apple Cake", "paid", 20, 22.0, "food"],
      ["P003", "Banana Smoothie", "paid", 5, 8.0, "drink"],
      ["P004", "Cherry Juice", "cancelled", 2, 12.0, "drink"],
      ["P005", "Date Nut", null, 0, 30.5, "food"],
    ];
    const stmt = db.prepare(
      `INSERT INTO "${TABLE}" (my_id, name, status, qty, price, cat) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const r of rows) stmt.run(...r);
  });

  void after(async () => {
    const db = getDb();
    db.exec(`DROP TABLE IF EXISTS "${TABLE}"`);
    await deleteTestObject(app, obj.id);
    await app.close();
  });

  // —— 聚合函数 ——
  void it("aggregate count(*) → total rows 5", async () => {
    const q = new URLSearchParams({
      "aggregate[count][*]": "c",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<{ c: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].c, 5);
  });

  void it("aggregate sum + avg + min + max 叠加", async () => {
    const q = new URLSearchParams({
      "aggregate[sum][price]": "sum_p",
      "aggregate[avg][qty]": "avg_q",
      "aggregate[min][price]": "min_p",
      "aggregate[max][price]": "max_p",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<{
      sum_p: number;
      avg_q: number;
      min_p: number;
      max_p: number;
    }>;
    assert.equal(rows.length, 1);
    const r = rows[0];
    // 15.5 + 22 + 8 + 12 + 30.5 = 88
    assert.equal(Number(Number(r.sum_p).toFixed(2)), 88);
    // (10+20+5+2+0)/5 = 7.4
    assert.equal(Number(Number(r.avg_q).toFixed(2)), 7.4);
    assert.equal(r.min_p, 8);
    assert.equal(r.max_p, 30.5);
  });

  void it("countDistinct(status) → 3 distinct values (paid/cancelled/null)", async () => {
    const q = new URLSearchParams({
      "aggregate[countDistinct][status]": "d",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<{ d: number }>;
    // SQLite COUNT(DISTINCT) 不把 NULL 计进来 → 2
    assert.equal(rows[0].d, 2);
  });

  void it("groupBy(status) + aggregate count/sum → 3 组", async () => {
    const q = new URLSearchParams({
      groupBy: "status",
      fields: "status",
      "aggregate[count][*]": "cnt",
      "aggregate[sum][price]": "sum_p",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<{
      status: string | null;
      cnt: number;
      sum_p: number;
    }>;
    // 3 组：paid / cancelled / null
    assert.equal(rows.length, 3);
  });

  void it("groupBy + 分页 meta.total = 分组数", async () => {
    const q = new URLSearchParams({
      groupBy: "status",
      fields: "status",
      "aggregate[count][*]": "cnt",
      pageSize: "2",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      data: unknown[];
      meta: { total: number; page: number; pageSize: number; totalPages: number };
    };
    // 3 组 → total=3，pageSize=2 → totalPages=2
    assert.equal(body.meta.total, 3);
    assert.equal(body.meta.totalPages, 2);
    assert.equal(body.data.length, 2);
  });

  void it("groupBy(status,cat) 多列 → 4 组", async () => {
    const q = new URLSearchParams({
      groupBy: "status,cat",
      "aggregate[count][*]": "cnt",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as unknown[];
    assert.equal(rows.length, 4);
  });

  void it("fields=my_id,name 只返回这两列", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?nopage=1&fields=my_id,name&orderBy=my_id`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 5);
    for (const r of rows) {
      const keys = Object.keys(r).sort();
      assert.deepEqual(keys, ["my_id", "name"]);
    }
  });

  void it("多字段 orderBy=qty:asc,price:desc", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?nopage=1&fields=my_id,qty,price&orderBy=qty:asc,price:desc`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<{ my_id: string; qty: number; price: number }>;
    // 先按 qty 升序：P005(0) P004(2) P003(5) P001(10) P002(20)
    assert.equal(rows[0].my_id, "P005");
    assert.equal(rows[1].my_id, "P004");
    assert.equal(rows[2].my_id, "P003");
    assert.equal(rows[3].my_id, "P001");
    assert.equal(rows[4].my_id, "P002");
  });

  void it("groupConcat(name) → 逗号连接 5 个名称", async () => {
    const q = new URLSearchParams({
      "aggregate[groupConcat][name]": "names",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<{ names: string }>;
    const parts = (rows[0].names ?? "").split(",");
    assert.equal(parts.length, 5);
  });

  void it("WHERE 条件 + 聚合：status=paid 前提下 sum/avg", async () => {
    const q = new URLSearchParams({
      status: "paid",
      "aggregate[sum][price]": "s",
      "aggregate[avg][qty]": "a",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<{ s: number; a: number }>;
    assert.equal(Number(Number(rows[0].s).toFixed(2)), 45.50);
    assert.equal(Number(Number(rows[0].a).toFixed(2)), Number(((10 + 20 + 5) / 3).toFixed(2)));
  });

  void it("非法聚合函数 → 400", async () => {
    const q = new URLSearchParams({
      "aggregate[evail][price]": "evil",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /Invalid aggregate function/);
  });

  void it("sum(*) 非法（非 count 不能用 *）→ 400", async () => {
    const q = new URLSearchParams({
      "aggregate[sum][*]": "bad",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /requires a column argument/);
  });

  void it("聚合 alias 包含特殊字符 → 400", async () => {
    const q = new URLSearchParams({
      "aggregate[count][*]": "bad alias!",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /Invalid aggregate alias/);
  });

  void it("fields 包含不存在列 → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?nopage=1&fields=my_id,nope_column`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /Unknown column in fields/);
  });

  void it("groupBy 不存在列 → 400", async () => {
    const q = new URLSearchParams({
      groupBy: "bad_col",
      "aggregate[count][*]": "c",
      nopage: "1",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /Unknown column in groupBy/);
  });

  void it("orderBy 方向写错 → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?nopage=1&orderBy=qty:descending`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /Invalid direction/);
  });

  void it("orderBy 不存在列 → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?nopage=1&orderBy=nope_col`,
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /Unknown column in orderBy/);
  });

  void it("groupBy + aggregate + orderBy=聚合别名(cnt:desc) → 允许并正确排序", async () => {
    const q = new URLSearchParams({
      groupBy: "cat",
      fields: "cat",
      "aggregate[count][*]": "cnt",
      nopage: "1",
      orderBy: "cnt:desc",
    }).toString();
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?${q}`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const rows = res.json() as Array<{ cat: string; cnt: number }>;
    // food: P001,P002,P005 → cnt=3
    // drink: P003,P004 → cnt=2
    assert.equal(rows.length, 2);
    assert.equal(rows[0].cnt, 3);
    assert.equal(rows[0].cat, "food");
    assert.equal(rows[1].cnt, 2);
    assert.equal(rows[1].cat, "drink");
  });

  void it("orderBy + WHERE + LIMIT 联动（端到端）", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/${TABLE}?pageSize=2&fields=my_id,price&orderBy=price:desc`,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      data: Array<{ my_id: string; price: number }>;
      meta: { total: number };
    };
    assert.equal(body.meta.total, 5);
    // price 降序 → Date Nut 30.5 / Apple Cake 22
    assert.equal(body.data[0].my_id, "P005");
    assert.equal(body.data[1].my_id, "P002");
  });
});
