/**
 * per-object CORS 插件 + 管理端全局兜底 —— 零外部依赖。
 *
 * 设计：
 *   A. 业务项目路径（/api/:object/:table、/api/custom/:name）：
 *      CORS 策略绑定 object 表每行的 cors_origins / cors_methods，
 *      管理端 PUT /api/config/objects/:id 修改后立即生效（无需重建 map）。
 *
 *   B. 管理端/系统路径（/api/auth/*、/api/admin/*、/api/config/*、/api/users/*、/health）：
 *      cors.ts 统一兜底，允许 .env 中 ADMIN_CORS_ORIGINS 指定的 Origin 跨域访问。
 *      未配置 ADMIN_CORS_ORIGINS 时默认 "*"（管理端接口通常是内部用，但开发/调试期要能跨）。
 *
 * 工作原理：
 *   1. onRequest 钩子拦截所有请求（在路由匹配前，OPTIONS 预检也能正确返回 204）
 *   2. URL 解析分三条路径：
 *        a) 自定义 SQL：/api/custom/<templateName>
 *              → 查 query_template.name JOIN object → cors_origins / cors_methods
 *        b) 通用 CRUD：/api/<object>/<table>
 *              → 查 object.name → cors_origins / cors_methods
 *        c) 管理端/系统路径 → 全局兜底（读 .env ADMIN_CORS_ORIGINS）
 *   3. 对请求 Header.Origin 做白名单匹配（`*` 或精确匹配）
 *   4. 通过则设置 Access-Control-Allow-Origin / Methods / Headers / Credentials / Max-Age
 *   5. OPTIONS 预检请求直接 204 No Content，避免进入路由。
 */

import fp from "fastify-plugin";
import { type FastifyPluginCallback } from "fastify";
import { getDb } from "../db.js";

interface ObjectCorsRow {
  cors_origins: string | null;
  cors_methods: string | null;
}

/** 从 URL path 中提取 object 的 CORS 配置
 *  两条路径模式：
 *    /api/<object>/<table>/... → 通用 CRUD（object 表 name 字段）
 *    /api/custom/<name>/...    → 自定义 SQL（query_template.name → object JOIN）
 */
function resolveObjectCors(url: string): ObjectCorsRow | null {
  const path = url.split("?")[0];

  // 管理端/系统路径 → 全局兜底
  const isAdminPath =
    path === "/health" ||
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/admin/") ||
    path.startsWith("/api/config/") ||
    path.startsWith("/api/users") ||
    path.startsWith("/api/roles") ||
    path.startsWith("/api/role-users") ||
    path.startsWith("/api/system/");
  if (isAdminPath) {
    const adminOrigins = (process.env.ADMIN_CORS_ORIGINS ?? "*").trim();
    const adminMethods = (process.env.ADMIN_CORS_METHODS ?? "GET,POST,PUT,PATCH,DELETE,OPTIONS").trim();
    return { cors_origins: adminOrigins, cors_methods: adminMethods };
  }

  // /api/custom/<name> / /api/custom/<name>/...
  const mCustom = path.match(/^\/api\/custom\/([a-zA-Z0-9_]+)(?:\/|$)/);
  if (mCustom) {
    try {
      const row = getDb()
        .prepare(
          `SELECT o.cors_origins, o.cors_methods FROM query_template t JOIN object o ON o.id = t.object_id WHERE t.name = ?`
        )
        .get(mCustom[1]) as ObjectCorsRow | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }
  // /api/<object>/<table>/...
  const m = path.match(/^\/api\/([a-zA-Z0-9_]+)\//);
  if (!m) return null;
  try {
    const row = getDb()
      .prepare("SELECT cors_origins, cors_methods FROM object WHERE name = ?")
      .get(m[1]) as ObjectCorsRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

const corsPlugin: FastifyPluginCallback = (fastify, _opts, done) => {
  fastify.addHook("onRequest", async (request, reply) => {
    const corsRow = resolveObjectCors(request.url);
    if (!corsRow) return; // 非 /api/:object/ 路径，不处理

    const originsRaw = corsRow.cors_origins;
    // 业务项目未显式配置 cors_origins 时，默认 fallback 允许所有 origin 跨域。
    // 管理员若想收紧范围，必须显式填写 cors_origins（如 "http://trusted.com,https://foo.net"）。
    // admin 兜底路径已在上游 resolveObjectCors 里处理过了（ADMIN_CORS_ORIGINS ?? "*"），
    // 不会走到这里。
    const effectiveOrigins = originsRaw?.trim() || "*";

    const origin = request.headers.origin;
    if (!origin) return; // 非跨域请求，不需要 CORS 头

    // 解析 origins（逗号分隔；已做 NULL fallback）
    const origins = effectiveOrigins
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    const allowed = origins.includes("*") || origins.includes(origin);
    if (!allowed) {
      // Origin 不在白名单：不设 CORS 头，浏览器会拦截响应
      return;
    }

    // 解析 methods（逗号分隔；NULL = 全部方法）
    const methods = corsRow.cors_methods
      ? corsRow.cors_methods
        .split(",")
        .map(s => s.trim().toUpperCase())
        .filter(Boolean)
        .join(",")
      : "GET,POST,PUT,PATCH,DELETE,OPTIONS";

    // 设置 CORS 响应头
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Methods", methods);
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Client-Id");
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Access-Control-Max-Age", "86400");

    // OPTIONS 预检请求：直接 204 返回，不走路由
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  done();
};

export default fp(corsPlugin);
