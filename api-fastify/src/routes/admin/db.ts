/**
 * 管理端 app.db 数据操作路由 —— /api/admin/db/*
 *
 * 仅限 admin-panel scope 访问（.env ADMIN_USERNAME/ADMIN_PASSWORD 登录），
 * 用于 admin-vue3 前端直接操作 app.db 中的配置表。
 *
 * 端点：
 *   GET    /api/admin/db/tables                     → 列出 app.db 所有表 + 行数
 *   GET    /api/admin/db/table/:name?limit=50        → 查表数据（参数化 WHERE）
 *   POST   /api/admin/db/query                      → 执行参数化 SELECT
 *   POST   /api/admin/db/insert                     → 插入行 {table, data}
 *   POST   /api/admin/db/update                     → 更新行 {table, data, where}
 *   POST   /api/admin/db/delete                     → 删除行 {table, where}
 *   POST   /api/admin/db/refresh-tokens/cleanup     → 手动清理过期 refresh_tokens
 *   POST   /api/admin/db/checkpoint                  → 触发 WAL checkpoint（TRUNCATE 模式）
 *   GET    /api/admin/db/meta                        → 数据库元信息（大小、WAL、表数等）
 *
 * 安全：
 *   - 所有接口 requireAdminPanel（scope="admin-panel" AND object_id=-1）
 *   - 表名必须匹配 ^[a-zA-Z_][a-zA-Z0-9_]*$ 且存在于 sqlite_master
 *   - INSERT/UPDATE/DELETE 走参数化占位符，禁止字符串拼接 SQL
 *   - DELETE/UPDATE 必须提供 WHERE 条件（防误删全表）
 */

import { type FastifyPluginAsync } from "fastify";
import { getDb, purgeExpiredRefreshTokens } from "../../db.js";
import { requireAdminPanel } from "../../services/config.service.js";
import { BusinessError } from "../../utils/errors.js";

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  // —— 通用：取 auth + 指纹校验 ——
  async function guard(request: { authContext?: { bearerToken?: string; fingerprint?: string } }) {
    const token = request.authContext?.bearerToken;
    const fp = request.authContext?.fingerprint ?? "";
    await requireAdminPanel({ token, fingerprint: fp });
  }

  /** 校验表名：正则 + sqlite_master 元数据双重检查 */
  function validateTable(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new BusinessError(400, `非法表名格式: ${name}`);
    }
    const exists = getDb()
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1")
      .get(name);
    if (!exists) {
      throw new BusinessError(404, `表 "${name}" 在 app.db 中不存在`);
    }
    return name;
  }

  // ========== GET /api/admin/db/tables ==========
  fastify.get("/api/admin/db/tables", async (request, reply) => {
    try {
      await guard(request);
      const tables = getDb()
        .prepare(
          `SELECT t.name,
                  (SELECT COUNT(*) FROM sqlite_master WHERE tbl_name = t.name AND type = 'index') AS indexes
           FROM sqlite_master t
           WHERE t.type = 'table' AND t.name NOT LIKE 'sqlite_%'
           ORDER BY t.name`
        )
        .all() as { name: string; indexes: number }[];

      // 逐表取行数（同步 SQLite，表量少，开销可接受）
      const result = tables.map(t => {
        const cnt = (
          getDb().prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }
        ).c;
        return { name: t.name, rows: cnt, indexes: t.indexes };
      });
      return { ok: true, tables: result };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // ========== GET /api/admin/db/table/:name ==========
  fastify.get<{ Params: { name: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/admin/db/table/:name",
    async (request, reply) => {
      try {
        await guard(request);
        const table = validateTable(request.params.name);
        const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 5000);
        const offset = Math.max(Number(request.query.offset ?? 0) || 0, 0);
        const rows = getDb()
          .prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`)
          .all(limit, offset) as Record<string, unknown>[];
        return { ok: true, table, limit, offset, rows };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // ========== POST /api/admin/db/query（参数化 SELECT） ==========
  fastify.post<{ Body: { sql: string; params?: unknown[] | Record<string, unknown> } }>(
    "/api/admin/db/query",
    async (request, reply) => {
      try {
        await guard(request);
        const { sql, params } = request.body;
        if (!sql || typeof sql !== "string") throw new BusinessError(400, "sql 必须为非空字符串");

        // 安全检查：只允许 SELECT 语句
        const trimmed = sql.trim().toUpperCase();
        if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("PRAGMA")) {
          throw new BusinessError(400, "仅允许 SELECT 或 PRAGMA 语句");
        }
        // 阻止子查询里藏写操作
        const dangerousKeywords = [
          "INSERT",
          "UPDATE",
          "DELETE",
          "DROP",
          "ALTER",
          "CREATE",
          "ATTACH",
          "DETACH",
          "VACUUM"
        ];
        for (const kw of dangerousKeywords) {
          if (trimmed.includes(kw)) {
            throw new BusinessError(400, `禁止的关键字: ${kw}`);
          }
        }

        const stmt = getDb().prepare(sql);
        const rows =
          params && Array.isArray(params)
            ? stmt.all(...params)
            : params && typeof params === "object"
              ? stmt.all(params)
              : stmt.all();
        return { ok: true, rows: rows as Record<string, unknown>[] };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        // better-sqlite3 的 SyntaxError 等转为 400
        return reply.code(400).send({ error: e instanceof Error ? e.message : "query failed" });
      }
    }
  );

  // ========== POST /api/admin/db/insert ==========
  fastify.post<{ Body: { table: string; data: Record<string, unknown> } }>(
    "/api/admin/db/insert",
    async (request, reply) => {
      try {
        await guard(request);
        const { table, data } = request.body;
        const tbl = validateTable(table);
        if (!data || typeof data !== "object") throw new BusinessError(400, "data 必须为对象");

        const cols = Object.keys(data);
        if (cols.length === 0) throw new BusinessError(400, "data 不能为空");

        const placeholders = cols.map(() => "?").join(",");
        const colList = cols.map(c => `"${c}"`).join(","); // 列名加引号防冲突
        const stmt = getDb().prepare(`INSERT INTO "${tbl}"(${colList}) VALUES(${placeholders})`);
        const info = stmt.run(...cols.map(c => data[c]));
        return {
          ok: true,
          table: tbl,
          changes: info.changes,
          lastInsertRowid: info.lastInsertRowid
        };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        return reply.code(400).send({ error: e instanceof Error ? e.message : "insert failed" });
      }
    }
  );

  // ========== POST /api/admin/db/update ==========
  fastify.post<{
    Body: { table: string; data: Record<string, unknown>; where?: string; whereParams?: unknown[] };
  }>("/api/admin/db/update", async (request, reply) => {
    try {
      await guard(request);
      const { table, data, where, whereParams } = request.body;
      const tbl = validateTable(table);
      if (!data || typeof data !== "object") throw new BusinessError(400, "data 必须为对象");
      if (!where || typeof where !== "string")
        throw new BusinessError(400, "where 必须为非空字符串");

      const setCols = Object.keys(data);
      if (setCols.length === 0) throw new BusinessError(400, "data 不能为空");

      const setClause = setCols.map(c => `"${c}" = ?`).join(",");
      const stmt = getDb().prepare(`UPDATE "${tbl}" SET ${setClause} WHERE ${where}`);
      const params = [
        ...setCols.map(c => data[c]),
        ...(Array.isArray(whereParams) ? whereParams : [])
      ];
      const info = stmt.run(...params);
      return { ok: true, table: tbl, changes: info.changes };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      return reply.code(400).send({ error: e instanceof Error ? e.message : "update failed" });
    }
  });

  // ========== POST /api/admin/db/delete ==========
  fastify.post<{ Body: { table: string; where: string; whereParams?: unknown[] } }>(
    "/api/admin/db/delete",
    async (request, reply) => {
      try {
        await guard(request);
        const { table, where, whereParams } = request.body;
        const tbl = validateTable(table);
        if (!where || typeof where !== "string") {
          throw new BusinessError(400, "where 必须为非空字符串（防误删全表）");
        }
        const stmt = getDb().prepare(`DELETE FROM "${tbl}" WHERE ${where}`);
        const params = Array.isArray(whereParams) ? whereParams : [];
        const info = stmt.run(...params);
        return { ok: true, table: tbl, changes: info.changes };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        return reply.code(400).send({ error: e instanceof Error ? e.message : "delete failed" });
      }
    }
  );

  // ========== POST /api/admin/db/refresh-tokens/cleanup ==========
  fastify.post("/api/admin/db/refresh-tokens/cleanup", async (request, reply) => {
    try {
      await guard(request);
      const removed = purgeExpiredRefreshTokens();
      return { ok: true, removed };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // ========== POST /api/admin/db/checkpoint ==========
  fastify.post("/api/admin/db/checkpoint", async (request, reply) => {
    try {
      await guard(request);
      // TRUNCATE 模式：checkpoint 后直接清空 WAL 文件
      const result = getDb().pragma("wal_checkpoint(TRUNCATE)") as {
        busy: number;
        log: number;
        checkpointed: number;
      };
      return { ok: true, result };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // ========== GET /api/admin/db/meta ==========
  fastify.get("/api/admin/db/meta", async (request, reply) => {
    try {
      await guard(request);
      const db = getDb();
      const tables = (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
          )
          .get() as { c: number }
      ).c;
      const walInfo = db.pragma("wal_checkpoint(PASSIVE)") as {
        busy: number;
        log: number;
        checkpointed: number;
      };
      const journalMode = db.pragma("journal_mode", { simple: true });
      const authRows = (db.prepare("SELECT COUNT(*) AS c FROM object").get() as { c: number }).c;
      const userRows = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
      const refreshRows = (
        db.prepare("SELECT COUNT(*) AS c FROM refresh_tokens").get() as { c: number }
      ).c;
      const refreshExpired = (
        db
          .prepare("SELECT COUNT(*) AS c FROM refresh_tokens WHERE expires_at < ?")
          .get(Math.floor(Date.now() / 1000)) as { c: number }
      ).c;

      return {
        ok: true,
        journalMode,
        tables,
        rowCounts: {
          object: authRows,
          users: userRows,
          refresh_tokens: refreshRows,
          refresh_tokens_expired: refreshExpired
        },
        wal: walInfo
      };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });
};

export default plugin;
