/**
 * 角色管理 —— /api/roles + /api/role-users
 *
 * 两张表都在 app.db 中：
 *   roles      — id, role_name, flag(0=启用,1=禁用)
 *   role_user  — id, role_id, user_id   （多对多绑定表）
 *
 * 鉴权：admin-panel scope（requireAdminPanel）
 * 路由风格与 users.ts 保持一致 — 直接操作 app.db，不经过 datasource
 */

import { type FastifyPluginAsync } from "fastify";
import { getDb } from "../../db.js";
import { requireAdminPanel } from "../../services/config.service.js";
import { BusinessError } from "../../utils/errors.js";

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  async function guard(request: { authContext?: { bearerToken?: string; fingerprint?: string } }) {
    const token = request.authContext?.bearerToken;
    const fp = request.authContext?.fingerprint ?? "";
    await requireAdminPanel({ token, fingerprint: fp });
  }

  // ============ roles ============

  // GET /api/roles/batch?ids=1,2,3   按主键批量查角色
  fastify.get<{ Querystring: { ids?: string } }>("/api/roles/batch", async (request, reply) => {
    try {
      await guard(request);
      const { ids } = request.query;
      if (!ids || !ids.trim()) return reply.code(400).send({ error: "ids 必填" });
      const nums = ids
        .split(",")
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n) && n > 0);
      if (nums.length === 0) return [];
      const placeholders = nums.map(() => "?").join(",");
      return getDb()
        .prepare(`SELECT * FROM roles WHERE id IN (${placeholders}) ORDER BY id ASC`)
        .all(...nums);
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // GET /api/roles?flag=0&role_name=xx&mode=like|exact
  fastify.get<{ Querystring: { flag?: string; role_name?: string; mode?: string } }>(
    "/api/roles",
    async (request, reply) => {
      try {
        await guard(request);
        const { flag, role_name, mode } = request.query;
        const db = getDb();
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (flag !== undefined && flag !== "") {
          conditions.push("flag = ?");
          params.push(Number(flag));
        }
        if (role_name) {
          if (mode === "exact") {
            conditions.push("role_name = ?");
            params.push(role_name);
          } else {
            // 默认模糊查询（LIKE %val%）
            conditions.push("role_name LIKE ?");
            params.push(`%${role_name}%`);
          }
        }
        const sql =
          conditions.length > 0
            ? `SELECT * FROM roles WHERE ${conditions.join(" AND ")} ORDER BY id ASC`
            : "SELECT * FROM roles ORDER BY id ASC";
        return db.prepare(sql).all(...params);
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // GET /api/roles/:id   详情
  fastify.get<{ Params: { id: string } }>("/api/roles/:id", async (request, reply) => {
    try {
      await guard(request);
      const row = getDb().prepare("SELECT * FROM roles WHERE id = ?").get(Number(request.params.id));
      if (!row) return reply.code(404).send({ error: "角色不存在" });
      return row;
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // POST /api/roles   新建
  fastify.post<{ Body: { role_name?: string; flag?: number } }>("/api/roles", async (request, reply) => {
    try {
      await guard(request);
      const { role_name = "", flag = 0 } = request.body ?? {};
      const db = getDb();
      const info = db
        .prepare("INSERT INTO roles (role_name, flag) VALUES (?, ?)")
        .run(role_name, Number(flag));
      return db.prepare("SELECT * FROM roles WHERE id = ?").get(info.lastInsertRowid);
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // PUT /api/roles/:id   更新
  fastify.put<{ Params: { id: string }; Body: { role_name?: string; flag?: number } }>(
    "/api/roles/:id",
    async (request, reply) => {
      try {
        await guard(request);
        const id = Number(request.params.id);
        const db = getDb();
        const existing = db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as any;
        if (!existing) return reply.code(404).send({ error: "角色不存在" });
        const body = request.body ?? {};
        const role_name = body.role_name !== undefined ? body.role_name : existing.role_name;
        const flag = body.flag !== undefined ? Number(body.flag) : existing.flag;
        db.prepare("UPDATE roles SET role_name = ?, flag = ? WHERE id = ?").run(role_name, flag, id);
        return db.prepare("SELECT * FROM roles WHERE id = ?").get(id);
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // DELETE /api/roles/:id   删除（同时删 role_user 中的绑定）
  fastify.delete<{ Params: { id: string } }>("/api/roles/:id", async (request, reply) => {
    try {
      await guard(request);
      const id = Number(request.params.id);
      const db = getDb();
      const existing = db.prepare("SELECT * FROM roles WHERE id = ?").get(id);
      if (!existing) return reply.code(404).send({ error: "角色不存在" });
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM role_user WHERE role_id = ?").run(id);
        db.prepare("DELETE FROM roles WHERE id = ?").run(id);
      });
      tx();
      return { ok: true };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // ============ role_user ============

  // GET /api/role-users/batch?ids=1,2,3   按主键批量查绑定
  fastify.get<{ Querystring: { ids?: string } }>("/api/role-users/batch", async (request, reply) => {
    try {
      await guard(request);
      const { ids } = request.query;
      if (!ids || !ids.trim()) return reply.code(400).send({ error: "ids 必填" });
      const nums = ids
        .split(",")
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n) && n > 0);
      if (nums.length === 0) return [];
      const db = getDb();
      const placeholders = nums.map(() => "?").join(",");
      return db
        .prepare(
          `SELECT ru.*, r.role_name, r.flag, u.username FROM role_user ru LEFT JOIN roles r ON ru.role_id = r.id LEFT JOIN users u ON ru.user_id = u.id WHERE ru.id IN (${placeholders}) ORDER BY ru.id ASC`
        )
        .all(...nums);
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // GET /api/role-users?role_id=X&user_id=Y   列表（按 role_id 或 user_id 过滤）
  fastify.get<{ Querystring: { role_id?: string; user_id?: string } }>(
    "/api/role-users",
    async (request, reply) => {
      try {
        await guard(request);
        const { role_id, user_id } = request.query;
        const db = getDb();
        if (role_id !== undefined && role_id !== "") {
          return db
            .prepare(
              "SELECT ru.*, r.role_name, r.flag, u.username FROM role_user ru LEFT JOIN roles r ON ru.role_id = r.id LEFT JOIN users u ON ru.user_id = u.id WHERE ru.role_id = ? ORDER BY ru.id ASC"
            )
            .all(Number(role_id));
        }
        if (user_id !== undefined && user_id !== "") {
          return db
            .prepare(
              "SELECT ru.*, r.role_name, r.flag, u.username FROM role_user ru LEFT JOIN roles r ON ru.role_id = r.id LEFT JOIN users u ON ru.user_id = u.id WHERE ru.user_id = ? ORDER BY ru.id ASC"
            )
            .all(Number(user_id));
        }
        // 都不传，返回全量
        return db
          .prepare(
            "SELECT ru.*, r.role_name, r.flag, u.username FROM role_user ru LEFT JOIN roles r ON ru.role_id = r.id LEFT JOIN users u ON ru.user_id = u.id ORDER BY ru.id ASC"
          )
          .all();
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // POST /api/role-users   绑定 { role_id, user_id }
  fastify.post<{ Body: { role_id: number; user_id: number } }>(
    "/api/role-users",
    async (request, reply) => {
      try {
        await guard(request);
        const { role_id, user_id } = request.body ?? {};
        if (!role_id || !user_id) return reply.code(400).send({ error: "role_id 和 user_id 必填" });
        const db = getDb();
        const role = db.prepare("SELECT id FROM roles WHERE id = ?").get(Number(role_id));
        if (!role) return reply.code(404).send({ error: "角色不存在" });
        const user = db.prepare("SELECT id FROM users WHERE id = ?").get(Number(user_id));
        if (!user) return reply.code(404).send({ error: "用户不存在" });
        // 幂等：已存在则直接返回
        const existing = db
          .prepare("SELECT * FROM role_user WHERE role_id = ? AND user_id = ?")
          .get(Number(role_id), Number(user_id));
        if (existing) return existing;
        const info = db
          .prepare("INSERT INTO role_user (role_id, user_id) VALUES (?, ?)")
          .run(Number(role_id), Number(user_id));
        return db.prepare("SELECT * FROM role_user WHERE id = ?").get(info.lastInsertRowid);
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // DELETE /api/role-users/:id   解除绑定（按主键）
  fastify.delete<{ Params: { id: string } }>("/api/role-users/:id", async (request, reply) => {
    try {
      await guard(request);
      const id = Number(request.params.id);
      const db = getDb();
      const existing = db.prepare("SELECT * FROM role_user WHERE id = ?").get(id);
      if (!existing) return reply.code(404).send({ error: "绑定不存在" });
      db.prepare("DELETE FROM role_user WHERE id = ?").run(id);
      return { ok: true };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // POST /api/role-users/batch-set   批量设置某用户的角色（全量覆盖）
  // body: { user_id, role_ids: number[] }
  fastify.post<{ Body: { user_id: number; role_ids: number[] } }>(
    "/api/role-users/batch-set",
    async (request, reply) => {
      try {
        await guard(request);
        const { user_id, role_ids } = request.body ?? {};
        if (!user_id) return reply.code(400).send({ error: "user_id 必填" });
        if (!Array.isArray(role_ids)) return reply.code(400).send({ error: "role_ids 必须是数组" });
        const db = getDb();
        const user = db.prepare("SELECT id FROM users WHERE id = ?").get(Number(user_id));
        if (!user) return reply.code(404).send({ error: "用户不存在" });
        // 验证所有 role_id 存在
        for (const rid of role_ids) {
          const r = db.prepare("SELECT id FROM roles WHERE id = ?").get(Number(rid));
          if (!r) return reply.code(400).send({ error: `角色 ${rid} 不存在` });
        }
        const tx = db.transaction(() => {
          db.prepare("DELETE FROM role_user WHERE user_id = ?").run(Number(user_id));
          const ins = db.prepare("INSERT INTO role_user (role_id, user_id) VALUES (?, ?)");
          for (const rid of role_ids) ins.run(Number(rid), Number(user_id));
        });
        tx();
        const count = db.prepare("SELECT COUNT(*) as c FROM role_user WHERE user_id = ?").get(
          Number(user_id)
        ) as { c: number };
        return { ok: true, user_id: Number(user_id), role_count: count.c };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );
};

export default plugin;
