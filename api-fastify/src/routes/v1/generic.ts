/**
 * 通用 CRUD 路由 —— /api/:object/:table（元数据驱动 + Directus 风格过滤查询 + 聚合统计 + JOIN 关联子表）。
 *
 * URL 第一段不再是数据源名，而是 app.db 中 object 表定义的「项目名称」。
 * 每个请求先经 resolveObjectAccess 五道关卡：
 *   1. 项目存在（object.name，404）
 *   2. auth 认证（object.auth_required=1 时需有效且未过期的 Bearer accessToken + 客户端指纹匹配，401）
 *   3. 配置库自保护（object/object_table/users 表禁止通过通用接口访问，403）
 *   4. 数据源可用（object 行的 db_type/db_url/db_path 已在 registry 注册连接；连接失败/不存在 404/502）
 *   5. 表级限制（object_table：blocked 整表拒绝；allow_select/insert/update/delete 单操作拒绝，403）
 *   6. (新增) JOIN 子表：每张关联表也要再走一遍 resolveObjectAccess（blocked/allow_select/表白名单），否则 403。
 *
 * 接口清单：
 *   GET    /api/:object/:table                                   → 分页查询（默认 page=1 pageSize=20，返回 data + meta；支持聚合 + GROUP BY + fields 列裁剪 + join 嵌套）
 *   GET    /api/:object/:table/:id                               → 按主键查一行；?fields=a,b 仅返回指定列；?join= 支持嵌套关联子表
 *   POST   /api/:object/:table                                   → 添加行，201 返回回查整行；?fields=a,b 裁剪返回
 *   PUT    /api/:object/:table/:id                               → 更新行，返回 { ok:true, changes:<n>, row:{更新后新行} }；?fields=a,b 仅裁剪 row
 *   DELETE /api/:object/:table/:id                               → 按主键删除行，返回 { ok:true }
 *
 * 项目与表级限制的管理：/api/config/objects（见 routes/config/objects.ts）。
 *
 * =============================================================================
 * 关联子表（join 参数，所有 GET 查询端点共用）—— 约定优先，显式可覆盖
 * =============================================================================
 *
 *   语法：join=<term>,<term>,...（多关联用逗号分隔；URL 编码）
 *
 *   单项格式：<table>[:<type>][:<as>][:<onCol>]
 *     · table  — 同项目（object）下的另一张表名。必须先通过表白名单 & allow_select=1。
 *     · type   — one | many。省略则按外键约定自动推断（Rails/Django 风格）：
 *                 主表存在 singular(table)_id 列（如 users→user_id）→ one（外键在主表，指向子表 PK，1:1）
 *                 否则 → many（默认子表列 singular(mainTable)_id 指向主表 PK，1:N）
 *     · as     — 返回 JSON 中的嵌套字段名。省略：one=table，many=复数化 table（s/x/ch/sh→+es 其余→+s）。
 *                 注意不能与主表列名冲突（否则 400）。
 *     · onCol  — 外键列名。省略：one 时 = singular(table)_id（主表列）；many 时 = singular(mainTable)_id（子表列）。
 *
 *   示例：
 *     GET /api/sqlite_app/posts?join=users,comments
 *         → 每个 posts 行带 users（one，从 user_id→users.id） + comments（many，子表列 post_id→posts.id）
 *
 *   安全 & 性能：
 *     · 有 aggregate / groupBy 时 JOIN 自动忽略（聚合按主表语义，避免 JOIN 膨胀）。
 *     · 跨表 WHERE 过滤当前版本仅以主表字段生效，不支持子表列过滤。
 */

import { type FastifyPluginAsync } from "fastify";
import {
  list,
  getById,
  getOne,
  insertRow,
  updateRow,
  deleteRow,
  batchCreate,
  batchUpdate,
  batchDeleteByIds,
  batchDeleteByFilter,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX
} from "../../services/generic.service.js";
import { resolveObjectAccess } from "../../services/config.service.js";
import { BusinessError } from "../../utils/errors.js";
import { getDs } from "../../datasources/registry.js";
import { discoverSchema } from "../../utils/schema.js";
import { parseJoinQuery, validateJoins, type JoinDesc } from "../../utils/join.js";

/**
 * 路由层 join 预处理 & 权限 & schema 解析：
 *   1) parseJoinQuery 语法解析
 *   2) 逐表 resolveObjectAccess 过认证 + 表白名单 + blocked + allow_select（子表权限）
 *   3) discoverSchema 填 JoinDesc.schema
 *   4) validateJoins：one/many 外键列存在性校验 + one.on.foreign=PK 补齐
 */
async function resolveAndValidateJoins(
  objectName: string,
  mainTable: string,
  dsName: string,
  rawJoin: string | undefined,
  authCtx: { token?: string | null; fingerprint: string }
): Promise<JoinDesc[]> {
  if (!rawJoin) return [];
  const mainSchema = await discoverSchema(getDs(dsName), mainTable);
  const descs = parseJoinQuery(rawJoin, mainTable, mainSchema);
  if (descs.length === 0) return [];
  // 统一传给 resolveObjectAccess：要求 token 是 string | undefined
  const resolveCtx = {
    token: authCtx.token == null ? undefined : authCtx.token,
    fingerprint: authCtx.fingerprint
  };
  for (const d of descs) {
    const access = resolveObjectAccess(objectName, d.table, "select", resolveCtx);
    d.schema = await discoverSchema(getDs(access.dsName), d.table);
  }
  validateJoins(descs);
  return descs;
}

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  // GET /api/:object/:table — 分页 / 不分页 / 按条件查一行（Directus 风格过滤 + join 嵌套）
  fastify.get<{
    Params: { object: string; table: string };
    Querystring: Record<string, unknown>;
  }>("/api/:object/:table", async (request, reply) => {
    const { object, table } = request.params;
    const qShowSql =
      request.query.showSql === "1" || request.query.showSql === "true";
    try {
      const authArgs = {
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      };
      const access = resolveObjectAccess(object, table, "select", authArgs);
      const q: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.query)) {
        q[k] = v == null ? "" : String(v);
      }
      const joins = await resolveAndValidateJoins(object, table, access.dsName, q.join, authArgs);
      const showSql = qShowSql;

      if (q.__one === "1" || q.__one === "true") {
        return reply.send(await getOne(access.dsName, table, q, joins));
      }

      const noPageRaw = q.noPage ?? q.nopage;
      if (noPageRaw === "1" || noPageRaw === "true") {
        const result = await list(access.dsName, table, {
          nopage: true,
          query: q,
          orderByCSV: q.orderBy,
          order: q.order as "asc" | "desc" | undefined,
          joins,
          showSql
        });
        // nopage 保持向后兼容：默认只返回数组，showSql=true 时返回完整信封（data + meta + sql）
        return reply.send(showSql ? result : result.data);
      }

      const page = q.page ? parseInt(q.page, 10) : 1;
      const pageSizeRaw = q.pageSize ? parseInt(q.pageSize, 10) : NaN;
      const result = await list(access.dsName, table, {
        page: !Number.isFinite(page) || page < 1 ? 1 : page,
        pageSize:
          !Number.isFinite(pageSizeRaw) || pageSizeRaw < 1
            ? PAGE_SIZE_DEFAULT
            : Math.min(pageSizeRaw, PAGE_SIZE_MAX),
        query: q,
        orderByCSV: q.orderBy,
        order: q.order as "asc" | "desc" | undefined,
        joins,
        showSql
      });
      return reply.send(result);
    } catch (e) {
      if (e instanceof BusinessError) {
        const body: Record<string, unknown> = { error: e.message };
        if (qShowSql) {
          const sq = (e as Error & { sql?: string; sqlParams?: unknown[] }).sql;
          if (sq) {
            body.sql = sq;
            body.sqlParams = (e as Error & { sqlParams?: unknown[] }).sqlParams;
          }
        }
        return reply.code(e.statusCode).send(body);
      }
      // 非业务错误（如 SQLITE_ERROR）也尝试附带 sql
      if (qShowSql && e instanceof Error) {
        const body: Record<string, unknown> = { error: e.message };
        const sq = (e as Error & { sql?: string; sqlParams?: unknown[] }).sql;
        if (sq) {
          body.sql = sq;
          body.sqlParams = (e as Error & { sqlParams?: unknown[] }).sqlParams;
        }
        return reply.code(500).send(body);
      }
      throw e;
    }
  });

  // GET /api/:object/:table/:id — 按主键查一行（?fields + ?join）
  fastify.get<{
    Params: { object: string; table: string; id: string };
    Querystring: Record<string, unknown>;
  }>("/api/:object/:table/:id", async (request, reply) => {
    const { object, table, id } = request.params;
    try {
      const authArgs = {
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      };
      const access = resolveObjectAccess(object, table, "select", authArgs);
      const f = request.query?.fields;
      const j = request.query?.join;
      const fieldsCSV = f == null ? undefined : String(f);
      const rawJoin = j == null ? undefined : String(j);
      const joins = await resolveAndValidateJoins(object, table, access.dsName, rawJoin, authArgs);
      return reply.send(await getById(access.dsName, table, id, fieldsCSV, joins));
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // POST /api/:object/:table
  fastify.post<{
    Params: { object: string; table: string };
    Body: Record<string, unknown>;
    Querystring: Record<string, unknown>;
  }>("/api/:object/:table", async (request, reply) => {
    const { object, table } = request.params;
    try {
      const access = resolveObjectAccess(object, table, "insert", {
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      });
      const f = request.query?.fields;
      const fieldsCSV = f == null ? undefined : String(f);
      const result = await insertRow(access.dsName, table, request.body ?? {}, fieldsCSV);
      return reply.code(201).send(result);
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // PUT /api/:object/:table/:id
  fastify.put<{
    Params: { object: string; table: string; id: string };
    Body: Record<string, unknown>;
    Querystring: Record<string, unknown>;
  }>("/api/:object/:table/:id", async (request, reply) => {
    const { object, table, id } = request.params;
    try {
      const access = resolveObjectAccess(object, table, "update", {
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      });
      const f = request.query?.fields;
      const fieldsCSV = f == null ? undefined : String(f);
      return reply.send(await updateRow(access.dsName, table, id, request.body ?? {}, fieldsCSV));
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // DELETE /api/:object/:table/:id
  fastify.delete<{
    Params: { object: string; table: string; id: string };
    Querystring: { showSql?: string };
  }>("/api/:object/:table/:id", async (request, reply) => {
    const { object, table, id } = request.params;
    try {
      const access = resolveObjectAccess(object, table, "delete", {
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      });
      return reply.send(await deleteRow(access.dsName, table, id));
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // POST /api/:object/:table/batch-create — 批量创建（事务保证原子性）
  fastify.post<{
    Params: { object: string; table: string };
    Body: { rows: Array<Record<string, unknown>> };
    Querystring: { showSql?: string };
  }>("/api/:object/:table/batch-create", async (request, reply) => {
    const { object, table } = request.params;
    const access = resolveObjectAccess(object, table, "batch_insert", {
      token: request.authContext.bearerToken,
      fingerprint: request.authContext.fingerprint
    });
    try {
      const showSql = request.query.showSql === "1" || request.query.showSql === "true";
      const result = await batchCreate(access.dsName, table, request.body, showSql);
      return reply.code(201).send(result);
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // POST /api/:object/:table/batch-update — 批量更新（{ rows: [{ id, ...patch }] }，事务原子）
  fastify.post<{
    Params: { object: string; table: string };
    Body: { rows: Array<{ id: number | string;[k: string]: unknown }> };
    Querystring: { showSql?: string };
  }>("/api/:object/:table/batch-update", async (request, reply) => {
    const { object, table } = request.params;
    const access = resolveObjectAccess(object, table, "batch_update", {
      token: request.authContext.bearerToken,
      fingerprint: request.authContext.fingerprint
    });
    try {
      const showSql = request.query.showSql === "1" || request.query.showSql === "true";
      return reply.send(await batchUpdate(access.dsName, table, request.body, showSql));
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // POST /api/:object/:table/batch-delete — 批量按 ids 删除
  fastify.post<{
    Params: { object: string; table: string };
    Body: { ids: Array<string | number> };
    Querystring: { showSql?: string };
  }>("/api/:object/:table/batch-delete", async (request, reply) => {
    const { object, table } = request.params;
    const access = resolveObjectAccess(object, table, "batch_delete", {
      token: request.authContext.bearerToken,
      fingerprint: request.authContext.fingerprint
    });
    try {
      const showSql = request.query.showSql === "1" || request.query.showSql === "true";
      return reply.send(await batchDeleteByIds(access.dsName, table, request.body, showSql));
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // POST /api/:object/:table/batch-delete-filter — 批量按 filter 删除
  fastify.post<{
    Params: { object: string; table: string };
    Body: { filter: Record<string, unknown> };
    Querystring: { showSql?: string };
  }>("/api/:object/:table/batch-delete-filter", async (request, reply) => {
    const { object, table } = request.params;
    const access = resolveObjectAccess(object, table, "batch_delete", {
      token: request.authContext.bearerToken,
      fingerprint: request.authContext.fingerprint
    });
    try {
      const showSql = request.query.showSql === "1" || request.query.showSql === "true";
      return reply.send(
        await batchDeleteByFilter(access.dsName, table, request.body, showSql)
      );
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });
};

export default plugin;
