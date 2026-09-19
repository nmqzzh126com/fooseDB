/**
 * 通用 CRUD 关联子表专项测试：
 *   · join=users:one:author + comments:many 嵌套返回；
 *   · 分页/nopage/__one/按主键 四种查询端点；
 *   · 表白名单 & allow_select=0 护栏：join 不允许的表 → 403；
 *   · 外键缺失 / 别名冲突 / 别名重复 → 400；
 *   · 有 aggregate[*] 时 join 被忽略（结果不嵌套）。
 *
 * 测试表：
 *   posts（已有）：id / user_id / title / content —— user_id 指向 users.id（1:1）
 *   comments：CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT,
 *                    post_id INTEGER NOT NULL, user_id INTEGER, body TEXT NOT NULL)
 *          —— post_id 指向 posts.id（1:N）。
 */

import "../setup-env.js";
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
} from "../helper-object.js";
import { getDb } from "../../src/db.js";
import { invalidateAllSchemas } from "../../src/utils/schema.js";

let app: FastifyInstance;

// 测试 object：tjoin_obj，先在 before 创建。
let obj: { id: number; name: string } | null = null;
// posts 行 ID
let POST_ID_A: number;
let POST_ID_B: number;
// admin / demo 用户 id（种子 id=1=admin, id=2=demo）

before(async () => {
  app = await buildTestApp();
  const db = getDb();
  // 确保 authors 表（JOIN one 测试用，非 guarded）存在，两列 id(PK),name
  db.exec(`CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  )`);
  // 确保 comments 表存在（JOIN many 测试用）
  db.exec(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER,
    body TEXT NOT NULL
  )`);
  // 清理本测试写入的 authors/comments 残留
  db.exec(`DELETE FROM comments WHERE body LIKE 'join test%'`);
  db.exec(`DELETE FROM authors WHERE name LIKE 'join test author%'`);

  // 写入 authors：两条（id=1→admin 代，id=2→demo 代）
  const insAuthor = db.prepare(`INSERT INTO authors(id,name) VALUES (?,?)`);
  try { insAuthor.run(1, "join test author A"); } catch { /* ignore if id=1 exists */ }
  try { insAuthor.run(2, "join test author B"); } catch { /* ignore if id=2 exists */ }

  obj = await createTestObject(app, { name: "tjoin_obj" });
  // 表白名单：posts + authors + comments（显式声明白名单以启用白名单模式，能测未声明表的 403）
  await createTableRule(app, obj.id, { table_name: "posts" });
  await createTableRule(app, obj.id, { table_name: "authors" });
  await createTableRule(app, obj.id, { table_name: "comments" });

  // 插入测试 posts：两条，author_id 对应 authors.id=1（post A）/ 2（post B）
  const pA = await app.inject({
    method: "POST",
    url: `/api/${obj.name}/posts`,
    headers: { "content-type": "application/json", ...(await adminHeaders(app)) },
    payload: JSON.stringify({ user_id: 1, title: "Join post A", content: "body A" }),
  });
  assert.equal(pA.statusCode, 201, pA.payload);
  POST_ID_A = JSON.parse(pA.payload).row.id;
  // 加 post.author_id 外键指向 authors.id：因为 posts 表的结构已在 helper-object.ts createTableRule 之前准备，
  // 我们用 direct SQL UPDATE 写 author_id 列 + 保证列存在。
  const postCols = (db.pragma(`table_info(posts)`) as Array<{ name: string }>).map((r) => r.name);
  if (!postCols.includes("author_id")) {
    db.exec(`ALTER TABLE posts ADD COLUMN author_id INTEGER`);
    // ALTER TABLE 后清所有 schema 缓存（多个 dsName 可能指向同一个 app.db 文件）
    invalidateAllSchemas();
  }
  db.prepare(`UPDATE posts SET author_id = ? WHERE id = ?`).run(1, POST_ID_A);

  const pB = await app.inject({
    method: "POST",
    url: `/api/${obj.name}/posts`,
    headers: { "content-type": "application/json", ...(await adminHeaders(app)) },
    payload: JSON.stringify({ user_id: 2, title: "Join post B", content: "body B" }),
  });
  assert.equal(pB.statusCode, 201, pB.payload);
  POST_ID_B = JSON.parse(pB.payload).row.id;
  db.prepare(`UPDATE posts SET author_id = ? WHERE id = ?`).run(2, POST_ID_B);

  // 写入 comments：A 3 条，B 1 条
  const ins = db.prepare(
    "INSERT INTO comments(post_id, user_id, body) VALUES (?,?,?)"
  );
  ins.run(POST_ID_A, 2, "join test comment A1");
  ins.run(POST_ID_A, 1, "join test comment A2");
  ins.run(POST_ID_A, 2, "join test comment A3");
  ins.run(POST_ID_B, 1, "join test comment B1");
});

after(async () => {
  const db = getDb();
  db.exec(`DELETE FROM comments WHERE body LIKE 'join test%'`);
  if (obj) {
    // 清理测试 posts
    db.prepare(`DELETE FROM posts WHERE id IN (?, ?)`).run(POST_ID_A, POST_ID_B);
    await deleteTestObject(app, obj.id);
  }
  if (app) await teardownTestApp(app);
});

// —— 1. nopage：join=authors,comments（one + many）——
test("JOIN nopage：authors(one→author) + comments(many) 双层嵌套", async () => {
  if (!obj) throw new Error("obj not created");
  const ids = encodeURIComponent(`${POST_ID_A},${POST_ID_B}`);
  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts?nopage=1&id[_in]=${ids}&join=authors:one:author,comments:many&orderBy=id:asc`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200, res.payload);
  const rows = JSON.parse(res.payload) as any[];
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 2, `expect 2 posts, got ${rows.length}`);

  // post A：author_id=1 → author.name="join test author A"；3 条 commentses（约定：many 时 comments 自动复数化为 commentses）
  const a = rows.find((r) => r.id === POST_ID_A)!;
  assert.ok(a);
  assert.equal(a.author?.name, "join test author A");
  assert.equal(a.commentses.length, 3);

  // post B：author_id=2 → author.name="join test author B"；1 条 comment
  const b = rows.find((r) => r.id === POST_ID_B)!;
  assert.ok(b);
  assert.equal(b.author?.name, "join test author B");
  assert.equal(b.commentses.length, 1);
});

// —— 2. 分页：meta.total 不被 many 膨胀 ——
test("JOIN page：meta.total 是主表 DISTINCT PK 数量（不被 many 膨胀）", async () => {
  if (!obj) throw new Error("obj not created");
  const ids = encodeURIComponent(`${POST_ID_A},${POST_ID_B}`);
  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts?page=1&pageSize=10&id[_in]=${ids}&join=comments&orderBy=id:asc`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200, res.payload);
  const body = JSON.parse(res.payload) as {
    data: any[];
    meta: { total: number; pageSize: number; page: number };
  };
  // 主表 2 条 posts，不应被 comments(4 行 total) 膨胀成 4
  assert.equal(body.meta.total, 2);
  assert.equal(body.data.length, 2);
  // 每条 data 的 commentses（many 时自动复数化）数正确
  const firstWithMany = body.data.find((r) => r.id === POST_ID_A);
  assert.ok(firstWithMany);
  assert.equal(Array.isArray(firstWithMany.commentses), true);
  assert.equal(firstWithMany.commentses.length, 3);
});

// —— 3. __one：按 title 条件查一行 + join ——
test(`JOIN __one：条件 title=Join post A，返回 author + comments 嵌套`, async () => {
  if (!obj) throw new Error("obj not created");
  const q = encodeURIComponent("Join post A");
  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts?__one=1&title=${q}&join=authors:one:author,comments:many`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200, res.payload);
  const row = JSON.parse(res.payload) as any;
  assert.equal(row.id, POST_ID_A);
  assert.equal(row.author?.id, 1);
  assert.equal(row.commentses.length, 3);
});

// —— 4. 按主键查：GET posts/:id + join（显式别名 author/replies + onCol）——
test(`JOIN byId：GET /posts/<A>?join=authors:one:author,comments:many:replies:post_id`, async () => {
  if (!obj) throw new Error("obj not created");
  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts/${POST_ID_A}?join=authors:one:author,comments:many:replies:post_id`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200, res.payload);
  const row = JSON.parse(res.payload) as any;
  assert.equal(row.id, POST_ID_A);
  assert.ok(row.author && typeof row.author === "object");
  assert.equal(row.author.name, "join test author A");
  // many 显式别名 replies，默认 comments 的 many 复数化是 commentses，但这里显式别名是 replies
  assert.ok(Array.isArray(row.replies));
  assert.equal(row.replies.length, 3);
});

// —— 5. 护栏：表白名单未列的表 join → 403 白名单 ——
test(`JOIN 护栏：未声明表 join=random_table → 403（白名单）`, async () => {
  if (!obj) throw new Error("obj not created");
  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts?nopage=1&join=random_never_declared`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 403, res.payload);
  assert.match(
    JSON.parse(res.payload).error,
    /白名单|object_table/
  );
});

// —— 6. 护栏：allow_select=0 的表（通过 PUT 更新现有规则 allow_select=0）join → 403 ——
test(`JOIN 护栏：子表 allow_select=0 时，join 被拒绝 403`, async () => {
  if (!obj) throw new Error("obj not created");
  // 先 GET 现有 comments 规则（before 中已 createTableRule 默认 allow_select=1）
  const listRules = await app.inject({
    method: "GET",
    url: `/api/config/objects/${obj.id}/tables`,
    headers: await adminHeaders(app),
  });
  assert.equal(listRules.statusCode, 200, listRules.payload);
  const page = JSON.parse(listRules.payload) as {
    items: Array<{
      id: number;
      table_name: string;
      allow_select: number;
    }>;
  };
  const commentRule = page.items.find((r) => r.table_name === "comments");
  assert.ok(commentRule, "comments rule should exist from before hook createTableRule default allow_select=1");

  try {
    // PUT allow_select=0
    const putR = await app.inject({
      method: "PUT",
      url: `/api/config/tables/${commentRule.id}`,
      headers: {
        "content-type": "application/json",
        ...(await adminHeaders(app)),
      },
      payload: JSON.stringify({ allow_select: 0 }),
    });
    assert.equal(putR.statusCode, 200, putR.payload);

    const res = await app.inject({
      method: "GET",
      url: `/api/${obj.name}/posts?nopage=1&join=comments`,
      headers: await adminHeaders(app),
    });
    assert.equal(res.statusCode, 403, res.payload);
    assert.match(JSON.parse(res.payload).error, /禁止 select|allow_select/);
  } finally {
    // 还原 allow_select=1
    await app.inject({
      method: "PUT",
      url: `/api/config/tables/${commentRule.id}`,
      headers: {
        "content-type": "application/json",
        ...(await adminHeaders(app)),
      },
      payload: JSON.stringify({ allow_select: 1 }),
    });
  }
});

// —— 7. 语法：one 时主表找不到 FK 列 → 400；many 时子表找不到 onCol → 400 ——
test(`JOIN 语法校验：one 关联需要主表 <table>_id 列，不存在 → 400`, async () => {
  if (!obj) throw new Error("obj not created");
  // users 主表 join tags（数据库无 tags_id 列） → 预期 400
  // 先把 users 表也已在白名单（之前已写），直接 join
  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/users?nopage=1&join=tags`, // users 主表，tags 子表，users 没 tags_id 列，many 推断但白名单里没 tags→其实白名单先拦，换一个已白名单但外键不符的
    headers: await adminHeaders(app),
  });
  // 因为 tags 不在白名单 → 这里先 403（白名单），符合预期但我们要测外键缺失。
  // 改：posts(有 title 等) join users:one:u:non_exist_col → onCol 显式不存在
  const res2 = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts?nopage=1&join=users:one:myauthor:noSuchColumn`, // one onCol = 主表列 noSuchColumn 不存在 → 400
    headers: await adminHeaders(app),
  });
  assert.equal(res2.statusCode, 400, res2.payload);
  assert.match(
    JSON.parse(res2.payload).error,
    /expected local FK column|column not found/
  );
});

// —— 8. 别名与主表列冲突 → 400 ——
test(`JOIN 别名冲突：join=users:one:id（主表已有 id 列） → 400`, async () => {
  if (!obj) throw new Error("obj not created");
  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts?nopage=1&join=users:one:id`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 400, res.payload);
  assert.match(JSON.parse(res.payload).error, /conflicts with a column/);
});

// —— 9. aggregate 存在时：join 被忽略（不嵌套，结果平铺，COUNT 仅主表两条）——
test(`JOIN + aggregate[count][*]=c：join 被忽略，返回仅聚合列（主表行数 2）`, async () => {
  if (!obj) throw new Error("obj not created");
  // 显式 WHERE id IN (A,B) 避免统计其他残留 posts
  const idsParam = encodeURIComponent(`${POST_ID_A},${POST_ID_B}`);
  const res = await app.inject({
    method: "GET",
    url: `/api/${obj.name}/posts?nopage=1&id[_in]=${idsParam}&aggregate[count][*]=c&join=comments`,
    headers: await adminHeaders(app),
  });
  assert.equal(res.statusCode, 200, res.payload);
  const rows = JSON.parse(res.payload) as any[];
  assert.equal(rows.length, 1);
  const row = rows[0] as Record<string, unknown>;
  // join=comments 已被忽略（有聚合不 join），所以行里没有 comments 字段
  assert.equal("comments" in row, false);
  assert.equal(Number(row.c), 2);
});
