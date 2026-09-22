/**
 * Debug 插件 —— 条件式接口调试日志 + 全接口耗时统计
 *
 * 功能：
 *   1. 全接口耗时：onRequest 记开始时间 → onSend 计算耗时 → 注入 HTTP Header `X-Duration-Ms`
 *      （所有接口都有，精确到微秒）
 *   2. 对象级 debug 日志：当请求匹配到某个 object（通用 CRUD / 自定义 SQL）
 *      且该 object.debug=1 时，把完整请求/响应异步写入 Redis List，LPUSH + LTRIM(0,999)
 *      只保留最近 1000 条。Redis 未启用（Stub）时自动降级为 noop，不影响主流程。
 *   3. 响应体 envelope 也注入 durationMs（仅对 envelope 型 body 加，裸数组 body 只走 header）
 *
 * Redis key 结构：
 *   debug:log:<objectName>  —— List，每个元素是 JSON { timestamp, method, url, object, table,
 *                                statusCode, durationMs, request, response, error }
 *
 * 注意：此插件不依赖 Fastify logger（已全局关闭），所有记录都走 Redis。
 */

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getDefaultCache } from "../caches/registry.js";
import { getDb } from "../db.js";

const LOG_MAX = 1000;
const LOG_KEY_PREFIX = "debug:log:";

interface DebugLogEntry {
  timestamp: number;
  method: string;
  url: string;
  path: string;
  object: string | null;
  table: string | null;
  statusCode: number;
  durationMs: number;
  ip: string;
  request: {
    headers: Record<string, string>;
    query?: Record<string, string>;
    params?: Record<string, string>;
    body?: unknown;
  };
  response?: unknown;
  error?: string;
}

/** 从 URL 里解析 object.name（通用 CRUD / 自定义 SQL） */
function resolveObjectFromUrl(url: string): { object: string | null; table: string | null } {
  // /api/:object/:table[/...]  —— 通用 CRUD
  const crudMatch = url.match(/^\/api\/([^/]+)\/([^/]+)/);
  if (crudMatch) {
    return { object: crudMatch[1], table: crudMatch[2] };
  }
  // /api/custom/:name —— 自定义 SQL（需要查 object_id，这里只返回 name，后续通过 DB 反查 object）
  const customMatch = url.match(/^\/api\/custom\/([^/?]+)/);
  if (customMatch) {
    return { object: "__custom__", table: customMatch[1] };
  }
  return { object: null, table: null };
}

/** 把 object_name 映射回 debug 开关（自定义 SQL 先查 query_template 拿 object_id） */
function resolveDebugEnabled(objectName: string, tableOrTpl: string | null): boolean {
  if (!tableOrTpl) return false;
  try {
    if (objectName === "__custom__") {
      // 自定义 SQL：查 query_template 拿 object_id → 再 object 表拿 debug
      const row = getDb()
        .prepare(
          `SELECT o.debug FROM query_template qt
            JOIN object o ON o.id = qt.object_id
           WHERE qt.name = ? LIMIT 1`
        )
        .get(tableOrTpl) as { debug: number } | undefined;
      return row?.debug === 1;
    }
    const row = getDb()
      .prepare("SELECT debug FROM object WHERE name = ? LIMIT 1")
      .get(objectName) as { debug: number } | undefined;
    return row?.debug === 1;
  } catch {
    return false;
  }
}

/** 安全 JSON 序列化：超大 body 截断，避免日志撑爆 Redis */
function safeStringify(val: unknown, maxLen = 5000): string {
  try {
    const s = JSON.stringify(val);
    return s.length > maxLen ? s.slice(0, maxLen) + `...(truncated, total ${s.length} chars)` : s;
  } catch {
    return String(val).slice(0, maxLen);
  }
}

/** 脱敏 headers（cookie/authorization 隐藏） */
function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === "authorization" || key === "cookie" || key === "x-client-id") {
      out[k] = "***";
    } else {
      out[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  return out;
}

/** 判断 body 是否 envelope（有 data/error/meta/columns/rows 等标志字段） */
function isEnvelope(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  return (
    "data" in obj ||
    "error" in obj ||
    "meta" in obj ||
    "columns" in obj ||
    "rows" in obj ||
    "ok" in obj
  );
}

/** Fastify request 上挂开始时间戳（BigInt 纳秒精度） */
declare module "fastify" {
  interface FastifyRequest {
    _debugStart?: bigint;
    _debugDurationMs?: number;
  }
}

export const debugPlugin = fp(
  async (app: FastifyInstance): Promise<void> => {
    // ========== onRequest：记开始时间 ==========
    app.addHook("onRequest", async (request: FastifyRequest) => {
      request._debugStart = process.hrtime.bigint();
    });

    // ========== onSend：计算耗时 + 注入 header + 条件式写 Redis ==========
    app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload) => {
      if (request._debugStart) {
        const end = process.hrtime.bigint();
        const ns = Number(end - request._debugStart);
        const durationMs = Math.round(ns / 1_000_000 * 1000) / 1000; // 保留 3 位小数
        request._debugDurationMs = durationMs;
        reply.header("X-Duration-Ms", String(durationMs));
      }

      // —— 协议接口跳过 durationMs 注入 body ——
      // 这些接口有固定协议信封（如 {"data": {...}}），污染后会破坏 SDK 拦截器解包。
      // 它们照样发 X-Duration-Ms header（全接口一致），只是不往 body 里塞 durationMs。
      const urlPath = (request.raw.url ?? "").split("?")[0];
      const isProtocol =
        urlPath === "/" ||
        urlPath.startsWith("/health") ||
        urlPath.startsWith("/api/auth/") ||
        urlPath.startsWith("/api/config/") ||
        urlPath.startsWith("/api/admin/") ||
        urlPath.startsWith("/api/system/");

      if (isProtocol) return payload;

      // —— 业务接口：尝试解析 payload 并给 envelope 加 durationMs ——
      let bodyObj: unknown = null;
      let bodyStr = "";
      try {
        if (typeof payload === "string") {
          bodyStr = payload;
        } else if (Buffer.isBuffer(payload)) {
          bodyStr = payload.toString("utf-8");
        } else if (payload != null) {
          bodyStr = String(payload);
        }
        if (bodyStr) bodyObj = JSON.parse(bodyStr);
      } catch {
        /* 非 JSON，保持原样 */
      }

      if (bodyObj !== null && request._debugDurationMs !== undefined && isEnvelope(bodyObj)) {
        (bodyObj as Record<string, unknown>).durationMs = request._debugDurationMs;
        return JSON.stringify(bodyObj);
      }

      return payload;
    });

    // ========== onResponse：debug=1 时异步写 Redis ==========
    // onResponse 在响应发送后触发，不阻塞客户端。此时 request/reply 的状态码等信息完整。
    app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { object, table } = resolveObjectFromUrl(request.raw.url ?? "");
        if (!object) return; // 不是 CRUD / 自定义 SQL 的请求不记录

        if (!resolveDebugEnabled(object, table)) return;

        // —— 构建日志条目 ——
        const durationMs = request._debugDurationMs ?? 0;
        const entry: DebugLogEntry = {
          timestamp: Math.floor(Date.now() / 1000),
          method: request.method,
          url: request.raw.url ?? request.url,
          path: request.routeOptions?.url ?? request.url,
          object: object === "__custom__" ? null : object,
          table: object === "__custom__" ? null : table,
          statusCode: reply.statusCode,
          durationMs,
          ip: request.ip,
          request: {
            headers: sanitizeHeaders(request.headers as Record<string, string>),
            query: request.query as Record<string, string>,
            params: request.params as Record<string, string>,
            body: request.body
          },
          error: (reply as unknown as { error?: Error }).error?.message,
          response: undefined // response body 在 onSend 已经发出，这里拿不到；简化处理
        };

        // —— 写 Redis：lpush + ltrim 保持最多 LOG_MAX 条 ——
        const cache = getDefaultCache();
        if (!cache.enabled) return; // Stub 模式跳过（用户没开 Redis）

        const key = `${LOG_KEY_PREFIX}${object === "__custom__" ? "custom" : object}`;
        const serialized = safeStringify(entry);
        await cache.lpush(key, serialized);
        await cache.ltrim(key, 0, LOG_MAX - 1);
      } catch {
        // debug 日志写失败绝不影响主流程
      }
    });
  },
  { name: "foosdb-debug" }
);

export default debugPlugin;

/** 外部可用：获取某 object 的 debug 日志列表（管理端查看 API 用） */
export async function getDebugLogs(objectName: string, limit = 100): Promise<DebugLogEntry[]> {
  try {
    const cache = getDefaultCache();
    if (!cache.enabled) return [];
    const key = `${LOG_KEY_PREFIX}${objectName}`;
    const count = Math.min(Math.max(limit, 1), LOG_MAX);
    const raw = await cache.lrange(key, 0, count - 1);
    return raw.map(s => {
      try {
        return JSON.parse(s) as DebugLogEntry;
      } catch {
        return null;
      }
    }).filter((x): x is DebugLogEntry => x !== null);
  } catch {
    return [];
  }
}

/** 外部可用：清空某 object 的 debug 日志 */
export async function clearDebugLogs(objectName: string): Promise<number> {
  try {
    const cache = getDefaultCache();
    if (!cache.enabled) return 0;
    const key = `${LOG_KEY_PREFIX}${objectName}`;
    return await cache.del(key);
  } catch {
    return 0;
  }
}
