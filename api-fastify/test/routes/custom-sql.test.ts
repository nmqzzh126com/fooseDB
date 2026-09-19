/**
 * 自定义 SQL 模块测试（POST /api/custom/:name + /api/config/query-templates CRUD）。
 *
 * ——— 测试前置依赖 ———
 *   · helper-object.buildTestApp()：构建 Fastify 实例（sqlite_app 唯一数据源，DISABLE_MYSQL_REDIS=1），
 *        app.inject() 方式发请求，不占用端口。
 *   · 两个测试项目：
 *        objPublic  auth_required=0（匿名可访问，role_required=public 时能直接跑）
 *        objAuth    auth_required=1（强制 Bearer token，demo user loginForTest 拿 access_token）
 *   · before：posts 表塞 6 行种子数据（admin/demo 交替的演示帖子）；after：删模板、删审计日志、删演示行，
 *        不留污染 app.db 的测试残留（配置库测试是共享状态，cleanup 必须完备，否则同一进程跑多轮会冲突）。
 *
 * ——— 本文件用例分组（与九条护栏一一对应）———
 *   护栏 1 每项目开关：custom_sql_enabled=1 时执行成功；custom_sql_enabled=0 → 503
 *   护栏 3 SELECT-only / 6 表黑名单：
 *                    · INSERT 开头 → 400 forbidden keyword
 *                    · SELECT users WHERE 1=1 → 400 "users" is guarded
 *                    · 含分号 "SELECT 1; DROP ..." → 400 multi-statement
 *                    · 含 PRAGMA / DROP → 400
 *                    · 含 query_template / custom_query_log → 400（模板自身不能通过自定义 SQL 看模板/日志，配置自保护）
 *   护栏 5 参数校验：
 *                    · 不写 schema 不传 params → 默认 required=true 400 missing
 *                    · 写 schema userId=integer 传字符串 → 400 must be number
 *                    · 命名占位 :name + 对象 params → 200，columns+rows 对齐
 *                    · 匿名占位 ? + 数组 params → 200
 *   护栏 7 认证 & 角色：
 *                    · objAuth.auth_required=1 + 无 token → 401 missing bearer token
 *                    · objAuth.auth_required=1 + 正确 token → 200
 *                    · objPublic + role_required=user + 匿名 → 401 login required
 *                    · objPublic + role_required=admin + demo token → 403
 *                    · objPublic + role_required=admin + admin token → 200
 *   护栏 9 审计日志：
 *                    · 成功查询后 custom_query_log 产生一行：row_count/duration_ms 合理，params_json 含实际传参
 *                    · 失败（例如 missing param）也写入一行：status_code=400, error_msg=missing required param
 *                    · 敏感参数 password/secret/token 传值：params_json 中被替换为 ***（SENSITIVE_FIELDS 正则脱敏）
 *   资源限制：
 *                    · rows_limit=2 时 SELECT 无 LIMIT → 结果数组最多 2 行（外层包 LIMIT N）
 *   注入攻击：
 *                    · params.title = "' OR '1'='1"，通过 ? 占位传递，不污染 SQL 语义；结果为 0 行而非全表
 *
 * ——— 新增测试的通用模式 ———
 *   1. createTemplate({ ...overrides }) 拿 templateId + name（自动加入 TEMPLATES cleanup 列表）
 *   2. injectJson("POST", `/api/custom/${name}`, { params: {...} }, headers?)
 *   3. 断言 statusCode + 响应字段 shape + 必要时直接查 app.db 验证审计日志
 *   4. after 钩子会清理模板/日志，禁止使用 CREATE TABLE / INSERT INTO query_template（绕过入库校验）
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  createTestObject,
  deleteTestObject,
  authHeaders,
  loginForTest,
  adminHeaders,
  //injectJson,
} from "../helper-object.js";
import { getDb } from "../../src/db.js";

void describe("自定义 SQL / custom + query_template CRUD", async () => {
  const app: FastifyInstance = await buildTestApp();
  const objPublic = await createTestObject(app, { name: "tpl_pub" });
  const objAuth = await createTestObject(app, { name: "tpl_sec", auth_required: 1 });

  const TEMPLATES: { name: string; tplId: number }[] = [];
  // 临时用户名列表（为测试 it12 绑定到 objAuth.id 的用户，after 统一清理）
  const TEMP_USERS: string[] = [];
  // 额外创建的测试项目（如 custom_sql_enabled=0 的项目）id，after 统一清理
  const EXTRA_OBJS: number[] = [];

  async function createTemplate(
    overrides: Record<string, unknown>
  ): Promise<{ id: number; name: string }> {
    const defaults: Record<string, unknown> = {
      object_id: objPublic.id,
      name:
        "tpl_" +
        Math.floor(Math.random() * 1e9).toString(36),
      sql_text: "SELECT id, user_id, title FROM posts WHERE user_id = :userId LIMIT 10",
      params_schema: null,
      role_required: "public",
      rows_limit: 100,
      timeout_ms: 1000,
      enabled: 1,
    };
    // 管理端创建模板需要 system admin 鉴权（users.object_id = -1）
    const res = await app.inject({
      method: "POST",
      url: "/api/config/query-templates",
      headers: {
        "content-type": "application/json",
        ...(await adminHeaders(app)),
      },
      payload: JSON.stringify({ ...defaults, ...overrides }),
    });
    if (res.statusCode >= 400)
      throw new Error(
        `createTemplate HTTP ${res.statusCode}: ${res.payload}`
      );
    const body = res.json() as { id: number; name: string };
    TEMPLATES.push({ name: body.name, tplId: body.id });
    return body;
  }

  void before(async () => {
    // 插入一批演示 posts，方便查（user_id 必须是 users 表中已有的主键：1=admin, 2=demo）
    const db = getDb();
    const stmt = db.prepare(
      "INSERT INTO posts(user_id, title, content) VALUES (?, ?, ?)"
    );
    for (let i = 1; i <= 6; i++) {
      stmt.run(i % 2 === 0 ? 1 : 2, `Post ${i}`, `Content ${i}`);
    }
  });

  void after(async () => {
    // 清理模板
    const db = getDb();
    const rm = db.prepare("DELETE FROM query_template WHERE name = ?");
    for (const t of TEMPLATES) rm.run(t.name);
    // 清理 posts 种子行
    db.exec(`DELETE FROM posts WHERE content LIKE 'Content %'`);
    // 清理临时绑定用户（先把 refresh_tokens / 其他关联表清空，users object_id reference 不指向 users，users 无 FK，可直删）
    const rmUser = db.prepare("DELETE FROM users WHERE username = ?");
    for (const u of TEMP_USERS) {
      db.prepare("DELETE FROM refresh_tokens WHERE user_id = (SELECT id FROM users WHERE username = ?)").run(u);
      rmUser.run(u);
    }
    await deleteTestObject(app, objPublic.id);
    await deleteTestObject(app, objAuth.id);
    for (const id of EXTRA_OBJS) await deleteTestObject(app, id);
    await app.close();
  });

  // ================== 管理端 CRUD ==================
  void it("POST /api/config/query-templates 成功创建 → 201 + SELECT-only 校验通过", async () => {
    const t = await createTemplate({ name: "posts_by_user" });
    assert.ok(t.id > 0);
  });

  void it("创建含 INSERT 的 SQL → 400（SELECT-only 拒绝）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/query-templates",
      headers: {
        "content-type": "application/json",
        ...(await adminHeaders(app)),
      },
      payload: JSON.stringify({
        object_id: objPublic.id,
        name: "bad_insert",
        sql_text: "INSERT INTO posts(user_id,title) VALUES(1,'x')",
      }),
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /INSERT/);
  });

  void it("创建 SQL 读 object 表（黑名单）→ 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/query-templates",
      headers: {
        "content-type": "application/json",
        ...(await adminHeaders(app)),
      },
      payload: JSON.stringify({
        object_id: objPublic.id,
        name: "read_object",
        sql_text: "SELECT * FROM object",
      }),
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /guarded/);
  });

  void it("params_schema 非法 JSON → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/query-templates",
      headers: {
        "content-type": "application/json",
        ...(await adminHeaders(app)),
      },
      payload: JSON.stringify({
        object_id: objPublic.id,
        name: "bad_json",
        sql_text: "SELECT * FROM posts WHERE id = :id",
        params_schema: "{not: valid}",
      }),
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /JSON/);
  });

  void it("创建同名模板 → 409 UNIQUE", async () => {
    const res1 = await createTemplate({ name: "dup_name_test" });
    assert.ok(res1.id);
    const res2 = await app.inject({
      method: "POST",
      url: "/api/config/query-templates",
      headers: {
        "content-type": "application/json",
        ...(await adminHeaders(app)),
      },
      payload: JSON.stringify({
        object_id: objPublic.id,
        name: "dup_name_test",
        sql_text: "SELECT 1",
      }),
    });
    assert.equal(res2.statusCode, 409, res2.payload);
  });

  // ================== 执行端：每项目 custom_sql_enabled 开关 ==================
  void it("custom_sql_enabled=0 的项目 → 模板执行返回 503", async () => {
    // 创建 custom_sql_enabled=0 的项目（按对象级开关，非全局）
    const objDisabled = await createTestObject(app, {
      name: "tpl_disabled",
      custom_sql_enabled: 0,
    });
    EXTRA_OBJS.push(objDisabled.id);
    const t = await createTemplate({
      object_id: objDisabled.id,
      sql_text: "SELECT 1 AS one",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ params: {} }),
    });
    assert.equal(res.statusCode, 503, res.payload);
    assert.match(res.json().error, /custom SQL is disabled/);
  });

  // ================== 执行端：成功路径 ==================
  void it("成功执行 posts_by_user → 200 含 rows + columns + 审计日志写入", async () => {
    const t = await createTemplate({
      sql_text:
        "SELECT id, title, user_id FROM posts WHERE user_id = :uid ORDER BY id ASC",
      params_schema: JSON.stringify({
        uid: { type: "integer", required: true },
      }),
    });
    const before = (
      getDb()
        .prepare("SELECT COUNT(*) c FROM custom_query_log")
        .get() as { c: number }
    ).c;
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ params: { uid: 1 } }),
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as {
      template: string;
      columns: string[];
      rows: Array<{ id: number; title: string; user_id: number }>;
      rowCount: number;
      durationMs: number;
    };
    assert.equal(body.template, t.name);
    assert.deepEqual(body.columns.sort(), ["id", "title", "user_id"].sort());
    assert.ok(body.rowCount >= 1);
    for (const r of body.rows) assert.equal(r.user_id, 1);
    const after = (
      getDb()
        .prepare("SELECT COUNT(*) c FROM custom_query_log")
        .get() as { c: number }
    ).c;
    assert.equal(after, before + 1);
  });

  // ================== 执行端：缺失参数 / 注入尝试 ==================
  void it("缺少必需参数 → 400 missing required param", async () => {
    const t = await createTemplate({
      sql_text: "SELECT * FROM posts WHERE user_id = :uid",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ params: {} }),
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error, /missing required param.*uid/);
  });

  void it("SQL 注入尝试：通过命名参数传含引号字符串，安全作为字面量执行", async () => {
    const t = await createTemplate({
      sql_text:
        "SELECT title FROM posts WHERE title = :name LIMIT 1",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        params: { name: "x'; DROP TABLE posts; -- " },
      }),
    });
    // 不会被注入：没查到就空数组
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { rowCount: number; rows: unknown[] };
    assert.equal(body.rowCount, 0);
    // posts 表必须还在
    const ck = await app.inject({
      method: "GET",
      url: `/api/${objPublic.name}/posts?pageSize=1`,
    });
    assert.equal(ck.statusCode, 200, ck.payload);
  });

  void it("rows_limit 生效：模板 rows_limit=1，结果只有 1 行（尽管有更多匹配）", async () => {
    const t = await createTemplate({
      sql_text: "SELECT id FROM posts WHERE user_id = 1",
      rows_limit: 1,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ params: {} }),
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { rowCount: number };
    assert.equal(body.rowCount, 1);
  });

  // ================== 执行端：认证继承 ==================
  void it("obj_auth=1 role_required=public → 无 token 401", async () => {
    const t = await createTemplate({
      object_id: objAuth.id,
      role_required: "public",
      sql_text: "SELECT 1 AS x",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ params: {} }),
    });
    assert.equal(res.statusCode, 401, res.payload);
  });

  void it("obj_auth=1，带 绑定用户 token → 200", async () => {
    const t = await createTemplate({
      object_id: objAuth.id,
      role_required: "public",
      sql_text: "SELECT 1 AS x",
    });
    // 说明：demo 用户默认绑定 object_id=1（种子 sqlite_app 默认项目），
    // 无权访问 objAuth(≠1) 上的自定义 SQL（需求 1 的用户-项目绑定）。
    // 所以此处新建一个临时绑定用户，object_id=objAuth.id，登录后调用应当 200。
    const username = "tpl_bound_" + Math.floor(Math.random() * 1e9).toString(36);
    const password = "Bound@1234";
    TEMP_USERS.push(username);
    const create = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: {
        "content-type": "application/json",
        ...(await adminHeaders(app)),
      },
      payload: JSON.stringify({ username, password, object_id: objAuth.id }),
    });
    assert.ok(create.statusCode === 200 || create.statusCode === 201, `createUser status: ${create.statusCode} ${create.payload}`);

    const token = (await loginForTest(app, username, password)).access_token;
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: {
        "content-type": "application/json",
        ...authHeaders(token),
      },
      payload: JSON.stringify({ params: {} }),
    });
    assert.equal(res.statusCode, 200, res.payload);
  });

  void it("role_required=admin，demo(user) 调用 → 403", async () => {
    const t = await createTemplate({
      object_id: objAuth.id,
      role_required: "admin",
      sql_text: "SELECT 1 AS x",
    });
    const token = (await loginForTest(app, "demo", "demo123")).access_token;
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: {
        "content-type": "application/json",
        ...authHeaders(token),
      },
      payload: JSON.stringify({ params: {} }),
    });
    assert.equal(res.statusCode, 403, res.payload);
  });

  void it("role_required=admin，admin 调用 → 200", async () => {
    const t = await createTemplate({
      object_id: objAuth.id,
      role_required: "admin",
      sql_text: "SELECT 1 AS x",
    });
    const token = (await loginForTest(app, "admin", "admin123")).access_token;
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: {
        "content-type": "application/json",
        ...authHeaders(token),
      },
      payload: JSON.stringify({ params: {} }),
    });
    assert.equal(res.statusCode, 200, res.payload);
  });

  void it("敏感参数审计日志脱敏：password=xxx → 存为 ***", async () => {
    const t = await createTemplate({
      sql_text: "SELECT id, title FROM posts WHERE id = :userId OR 1=0",
    });
    const beforeId = (
      getDb()
        .prepare(
          "SELECT COALESCE(MAX(id),0) AS m FROM custom_query_log"
        )
        .get() as { m: number }
    ).m;
    const res = await app.inject({
      method: "POST",
      url: `/api/custom/${t.name}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        params: { userId: 1, password: "secret-12345" },
      }),
    });
    assert.equal(res.statusCode, 200, res.payload);
    const row = getDb()
      .prepare(
        "SELECT params_json FROM custom_query_log WHERE id > ? ORDER BY id DESC LIMIT 1"
      )
      .get(beforeId) as { params_json: string } | undefined;
    assert.ok(row);
    assert.match(row.params_json, /"userId":1/);
    assert.match(row.params_json, /"password":"\*\*\*"/);
  });
});
