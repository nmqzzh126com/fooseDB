/**
 * 速率限流工具 + 可选全局限流插件。
 *
 * 算法：固定窗口（Fixed Window，基于 Redis INCR+EXPIRE 原子化）
 *   优点：代码极简、1 次 INCR+EXPIRE、对 Redis 压力最小；
 *   缺点：窗口边界处有 2x burst（如需更精确请改滑动窗口 ZSET 或令牌桶）。
 *
 * 使用方式：
 *   1) 函数式（已启用）：routes/v1/auth.ts 登录接口直接调用 ratelimitCheck()，
 *      实现 P1「IP 维度登录限流 5 次 / 60 秒」。
 *   2) 全局插件式（默认关闭）：给所有 /api/* 挂 onRequest 钩子。
 *      取消本文件末尾「全局限流插件」注释块即可启用。
 *
 * 降级：若指定 cache 不存在 / 是 Stub（Redis 未启用），ratelimitCheck 永远放行
 *      （allowed=true），不会出现「Redis 没启动就全站 429」。
 */

import { type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

// ————— 默认窗口与次数（全局插件模式使用）—————
const DEFAULT_LIMIT = 10; // 每窗口允许的请求数
const DEFAULT_WINDOW_SEC = 10; // 窗口大小（秒）

/**
 * 核心算法（独立于 plugin，便于在任意路由/场景复用）。
 *
 * 返回：{ allowed, remaining, retryAfterSec }
 *   - Stub / cache 未启用：永远 allowed=true
 *   - 达到上限：allowed=false，retryAfterSec 给前端写 Retry-After 响应头
 */
export async function ratelimitCheck(
  cacheName: "cache_ratelimit" | "cache_default" | (string & {}),
  subject: string, // 限流主体：一般是 `${req.ip}:${req.routerPath}`
  limitPerWindow = DEFAULT_LIMIT,
  windowSec = DEFAULT_WINDOW_SEC
): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }> {
  // 延迟 import（避免 registry 初始化前就被 import 触发找不到 cache 抛错）
  const { getCache } = await import("../caches/registry.js");
  let c: Awaited<ReturnType<typeof getCache>>;
  try {
    c = getCache(cacheName);
  } catch {
    // 没声明指定 cache → 降级到 cache_default，再不行 → 全局限流关闭
    try {
      c = getCache("cache_default");
    } catch {
      return { allowed: true, remaining: limitPerWindow, retryAfterSec: 0 };
    }
  }
  // Stub 未启用 → 放行（关键降级）
  if (!c.enabled) return { allowed: true, remaining: limitPerWindow, retryAfterSec: 0 };

  const key = `rl:${subject}`;
  const countAfter = await c.incr(key, 1);
  // 第一次：设置 TTL（INCR 返回 1 说明这是新 key）
  if (countAfter === 1) {
    await c.expire(key, windowSec);
  }
  if (countAfter > limitPerWindow) {
    const ttl = await c.getTtl(key);
    const retryAfterSec = ttl > 0 ? ttl : windowSec;
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  return {
    allowed: true,
    remaining: Math.max(0, limitPerWindow - countAfter),
    retryAfterSec: 0
  };
}

/* ==========================================================================
 * 【可选】全局限流插件：给全部 /api/* 业务路由统一限流（/admin 静态页和 /health 不限）。
 * 默认不注册（下方 noopPlugin 生效）。如需开启，删除 noopPlugin 并取消下面注释块。
 *
 * const globalRateLimit: FastifyPluginAsync = async (fastify): Promise<void> => {
 *   fastify.addHook("onRequest", async (req, reply) => {
 *     const path = req.raw.url ?? req.url ?? "";
 *     if (!path.startsWith("/api/")) return;
 *     const subject = `${req.ip}:${req.routerPath ?? path}`;
 *     const r = await ratelimitCheck("cache_ratelimit", subject, DEFAULT_LIMIT, DEFAULT_WINDOW_SEC);
 *     reply.header("X-RateLimit-Limit", String(DEFAULT_LIMIT));
 *     reply.header("X-RateLimit-Remaining", String(r.remaining));
 *     if (!r.allowed) {
 *       reply.header("Retry-After", String(r.retryAfterSec));
 *       reply.code(429).send({
 *         code: "TOO_MANY_REQUESTS | 请求过于频繁",
 *         message: `请求过于频繁，请 ${r.retryAfterSec} 秒后重试。`,
 *         retryAfterSec: r.retryAfterSec,
 *       });
 *     }
 *   });
 * };
 * export default fp(globalRateLimit);
 * ========================================================================== */

// —— 默认 noop 占位：autoload 扫到本文件时不挂任何全局钩子（限流在具体路由内按需调用）——
const noopPlugin: FastifyPluginAsync = async () => {
  /* 全局限流默认关闭；需要时按上方注释启用 globalRateLimit。 */
};

export default fp(noopPlugin);
