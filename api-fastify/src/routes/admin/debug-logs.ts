/**
 * Debug 日志查看接口 —— /api/admin/debug-logs/*
 *
 * 仅限 admin-panel scope 访问，从 Redis 中读取 object.debug=1 时记录的请求日志。
 * Redis 未启用（Stub 模式）时返回空列表 + warning 提示。
 *
 * 端点：
 *   GET  /api/admin/debug-logs?object=<name>&limit=100     → 获取某 object 的 debug 日志（最新在前）
 *   GET  /api/admin/debug-logs/objects                     → 列出所有有 debug 日志的 object 及其条数
 *   POST /api/admin/debug-logs/clear                       → 清空某 object（或全部）的 debug 日志
 *
 * 安全：
 *   - requireAdminPanel（scope="admin-panel" AND object_id=-1）
 *   - 参数化 Redis key，object 名会被转义，不会拼到 Lua 里
 */

import { type FastifyPluginAsync } from "fastify";
import { getDb } from "../../db.js";
import { requireAdminPanel } from "../../services/config.service.js";
import { BusinessError } from "../../utils/errors.js";
import { getDebugLogs, clearDebugLogs } from "../../plugins/debug.js";
import { getDefaultCache } from "../../caches/registry.js";

const CACHE_KEY_PREFIX = "debug:log:";

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  async function guard(request: { authContext?: { bearerToken?: string; fingerprint?: string } }) {
    const token = request.authContext?.bearerToken;
    const fp = request.authContext?.fingerprint ?? "";
    await requireAdminPanel({ token, fingerprint: fp });
  }

  // ========== GET /api/admin/debug-logs — 列表 ==========
  fastify.get<{ Querystring: { object?: string; limit?: string } }>(
    "/api/admin/debug-logs",
    async (request, reply) => {
      try {
        await guard(request);
        const objName = (request.query.object ?? "").trim();
        if (!objName) return reply.code(400).send({ error: "object 参数必填" });

        const limit = Math.min(Math.max(Number(request.query.limit ?? 100) || 100, 1), 1000);
        const cache = getDefaultCache();
        if (!cache.enabled) {
          return { ok: true, items: [], total: 0, warning: "Redis 未启用（Stub 模式），debug 日志不可用" };
        }

        const items = await getDebugLogs(objName, limit);
        const total = await cache.llen(`${CACHE_KEY_PREFIX}${objName}`);
        return { ok: true, items, total };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // ========== GET /api/admin/debug-logs/objects — 有日志的 object 清单 ==========
  // Redis 里用 SCAN 找所有 debug:log:* 的 key
  fastify.get("/api/admin/debug-logs/objects", async (request, reply) => {
    try {
      await guard(request);
      const cache = getDefaultCache();
      if (!cache.enabled) {
        return { ok: true, objects: [], warning: "Redis 未启用（Stub 模式）" };
      }
      // 缓存层没有 keys() 方法，暂时只返回 object 表中 debug=1 的项目清单
      // 将来需要精确"哪些 object 实际有日志"时给 Cache 接口加 keys(pattern)
      const rows = getDb()
        .prepare("SELECT name FROM object WHERE debug = 1 ORDER BY name")
        .all() as Array<{ name: string }>;
      const result = [] as Array<{ name: string; count: number }>;
      for (const r of rows) {
        try {
          const key = `${CACHE_KEY_PREFIX}${r.name}`;
          const count = await cache.llen(key);
          result.push({ name: r.name, count });
        } catch {
          result.push({ name: r.name, count: 0 });
        }
      }
      return { ok: true, objects: result };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // ========== POST /api/admin/debug-logs/clear — 清空 ==========
  fastify.post<{ Body: { object?: string } }>(
    "/api/admin/debug-logs/clear",
    async (request, reply) => {
      try {
        await guard(request);
        const objName = (request.body?.object ?? "").trim();
        if (!objName) return reply.code(400).send({ error: "object 参数必填" });

        const removed = await clearDebugLogs(objName);
        return { ok: true, removed, object: objName };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );
};

export default plugin;
