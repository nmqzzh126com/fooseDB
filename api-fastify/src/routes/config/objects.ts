/**
 * 元数据配置管理路由 —— /api/config/objects
 *
 * object（项目）：
 *   GET    /api/config/objects                    → 项目列表
 *   GET    /api/config/objects/:id                → 项目详情
 *   POST   /api/config/objects                    → 新建项目 {name, db_type, db_url?, db_path?, cors_origins?, cors_methods?, custom_sql_enabled?, auth_required?}
 *   PUT    /api/config/objects/:id                → 更新项目（description/db_type/db_url/db_path/cors_origins/cors_methods/custom_sql_enabled/auth_required）
 *   DELETE /api/config/objects/:id                → 删除项目（级联删除其表级限制）
 *
 * object_table（表级限制）：
 *   GET    /api/config/objects/:id/tables         → 该项目的限制规则列表
 *   POST   /api/config/objects/:id/tables         → 新增规则 {table_name, blocked?, allow_*?}
 *   PUT    /api/config/objects/:id/tables/:ruleId → 更新规则
 *   DELETE /api/config/objects/:id/tables/:ruleId → 删除规则
 *
 * 说明：
 *   - db_type 必须为 sqlite/mysql/postgres，否则 400
 *   - auth_required=1 后，该项目下所有 /api/:name/:table 通用接口需携带有效 Bearer accessToken
 */

import { type FastifyPluginAsync } from "fastify";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import {
  listObjects,
  getObject,
  createObject,
  updateObject,
  deleteObject,
  listTableRules,
  createTableRule,
  updateTableRule,
  deleteTableRule,
  getDatabaseInfo,
  requireSystemAdminForManage,
  requireAdminPanel
} from "../../services/config.service.js";
import { BusinessError } from "../../utils/errors.js";
import {
  CreateObjectSchema,
  UpdateObjectSchema,
  CreateTableRuleSchema,
  UpdateTableRuleSchema
} from "../../schemas/config.schema.js";

interface Body {
  [k: string]: unknown;
}

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  // —— object CRUD ——

  // GET 列表：管理端读接口，要求 system admin（避免绑定用户看全量项目定义）
  fastify.get("/api/config/objects", async (request, reply) => {
    try {
      requireSystemAdminForManage({
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      });
      return listObjects();
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // GET 单条：同样需要 system admin
  fastify.get<{ Params: { id: string } }>("/api/config/objects/:id", async (request, reply) => {
    try {
      requireSystemAdminForManage({
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      });
      return getObject(Number(request.params.id));
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // POST 创建：仅 system admin
  fastify.post<{ Body: Body }>(
    "/api/config/objects",
    { schema: { body: CreateObjectSchema } },
    async (request, reply) => {
      try {
        requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        const row = await createObject(
          request.body as unknown as Parameters<typeof createObject>[0]
        );
        return reply.code(201).send(row);
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // PUT 更新：仅 system admin
  fastify.put<{ Params: { id: string }; Body: Body }>(
    "/api/config/objects/:id",
    { schema: { body: UpdateObjectSchema } },
    async (request, reply) => {
      try {
        requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        return await updateObject(
          Number(request.params.id),
          request.body as unknown as Parameters<typeof updateObject>[1]
        );
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // DELETE：仅 system admin
  fastify.delete<{ Params: { id: string } }>("/api/config/objects/:id", async (request, reply) => {
    try {
      requireAdminPanel({
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      });
      await deleteObject(Number(request.params.id));
      return { ok: true };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // —— 测试数据源连接（独立临时连接，不注册到 registry）——
  // POST /api/config/objects/test-connection  { db_type, db_url?, db_path? }
  fastify.post<{ Body: Body }>("/api/config/objects/test-connection", async (request, reply) => {
    try {
      requireAdminPanel({
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      });

      const { db_type, db_url, db_path } = request.body as {
        db_type?: string;
        db_url?: string | null;
        db_path?: string | null;
      };

      if (!db_type) return reply.code(400).send({ error: "db_type 不能为空" });
      const type = db_type.toLowerCase();

      if (type === "sqlite") {
        const p = (db_path ?? "").trim();
        if (!p) return reply.code(400).send({ error: "SQLite 需要填写 db_path" });
        const abs = path.isAbsolute(p) ? p : path.resolve(p);
        // 目录是否存在
        const dir = path.dirname(abs);
        if (!fs.existsSync(dir)) return reply.code(400).send({ error: `目录不存在: ${dir}` });
        // 打开文件（不存在时 better-sqlite3 会自动创建；但测试只允许读已有文件，避免误建空库）
        if (!fs.existsSync(abs))
          return reply.code(400).send({ error: `文件不存在: ${abs}（请先创建 .db 文件）` });
        const db = new Database(abs, { readonly: true });
        try {
          db.pragma("journal_mode"); // 触发一次真实 IO
          db.prepare("SELECT 1 AS ok").get();
        } finally {
          db.close();
        }
        return { ok: true, message: `SQLite 连接成功: ${abs}` };
      }

      if (type === "mysql") {
        const url = (db_url ?? "").trim();
        if (!url) return reply.code(400).send({ error: "MySQL 需要填写 db_url" });
        try {
          const parsed = new URL(url);
          if (!parsed.hostname) throw new Error("缺少 host");
          if (!parsed.pathname || parsed.pathname === "/") throw new Error("缺少 database");
        } catch (e: any) {
          return reply.code(400).send({ error: `db_url 格式错误: ${e?.message ?? e}` });
        }
        const mysql = await import("mysql2/promise");
        let pool: import("mysql2/promise").Pool | null = null;
        try {
          const u = new URL(url);
          pool = mysql.createPool({
            host: u.hostname,
            port: Number(u.port || 3306),
            user: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password),
            database: u.pathname.replace(/^\//, ""),
            waitForConnections: true,
            connectionLimit: 1
          });
          await pool.query("SELECT 1 AS ok");
          return { ok: true, message: `MySQL 连接成功: ${u.hostname}:${u.port || 3306}/${u.pathname.replace(/^\//, "")}` };
        } catch (e: any) {
          return reply.code(400).send({ error: `MySQL 连接失败: ${e?.message ?? e}` });
        } finally {
          if (pool) {
            try {
              await pool.end();
            } catch {
              /* ignore */
            }
          }
        }
      }

      if (type === "postgres") {
        return reply.code(501).send({ error: "PostgreSQL 驱动尚未启用，请先 pnpm add pg" });
      }

      return reply.code(400).send({ error: `未知 db_type: ${db_type}` });
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // —— object_table CRUD ——

  // GET 列表：读接口，sysadmin — 支持分页 + 过滤
  fastify.get<{
    Params: { id: string };
    Querystring: { page?: string; pageSize?: string; table_name?: string; blocked?: string };
  }>(
    "/api/config/objects/:id/tables",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 500 },
            table_name: { type: "string" },
            blocked: { type: "integer", enum: [0, 1] }
          },
          additionalProperties: false
        }
      }
    },
    async (request, reply) => {
      try {
        requireSystemAdminForManage({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        const { page, pageSize, table_name, blocked } = request.query;
        return listTableRules(Number(request.params.id), {
          page: page ? Number(page) : undefined,
          pageSize: pageSize ? Number(pageSize) : undefined,
          table_name,
          blocked: blocked !== undefined ? (Number(blocked) as 0 | 1) : undefined
        });
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // POST 创建规则：仅 sysadmin — object_id 从 body 取
  fastify.post<{ Body: Body }>(
    "/api/config/tables",
    { schema: { body: CreateTableRuleSchema } },
    async (request, reply) => {
      try {
        requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        const row = createTableRule(
          request.body as unknown as Parameters<typeof createTableRule>[0]
        );
        return reply.code(201).send(row);
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // PUT 更新规则：仅 sysadmin — ruleId 是主键，无需 objectId
  fastify.put<{ Params: { ruleId: string }; Body: Body }>(
    "/api/config/tables/:ruleId",
    { schema: { body: UpdateTableRuleSchema } },
    async (request, reply) => {
      try {
        requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        return updateTableRule(
          Number(request.params.ruleId),
          request.body as unknown as Parameters<typeof updateTableRule>[1]
        );
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // DELETE 规则：仅 sysadmin — ruleId 是主键，无需 objectId
  fastify.delete<{ Params: { ruleId: string } }>(
    "/api/config/tables/:ruleId",
    async (request, reply) => {
      try {
        requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        deleteTableRule(Number(request.params.ruleId));
        return { ok: true };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // GET /api/config/objects/:id/dbinfo — 查询项目数据源中的所有表（管理端选取表名用）
  // excludeTable 支持重复 query：?excludeTable=users&excludeTable=posts 或逗号分隔
  // tableName 按表名模糊匹配 LIKE %xxx%
  fastify.get<{
    Params: { id: string };
    Querystring: { excludeTable?: string | string[]; tableName?: string };
  }>(
    "/api/config/objects/:id/dbinfo",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            excludeTable: {
              type: "array",
              items: { type: "string" }
            },
            tableName: { type: "string" }
          },
          additionalProperties: false
        }
      }
    },
    async (request, reply) => {
      try {
        requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        const raw = request.query.excludeTable;
        // Fastify 自动把 ?excludeTable=x 转 ["x"]，?excludeTable=x&excludeTable=y 转 ["x","y"]
        // 同时兼容逗号分隔的字符串手动 split
        let excludeTables: string[] | undefined;
        if (raw) {
          const arr = Array.isArray(raw) ? raw : [raw];
          excludeTables = arr.flatMap(s => s.split(",").map(v => v.trim()).filter(Boolean));
        }
        return await getDatabaseInfo(
          Number(request.params.id),
          excludeTables,
          request.query.tableName || undefined
        );
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );
};

export default plugin;
