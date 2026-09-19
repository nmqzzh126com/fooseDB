/**
 * 缓存声明的二次暴露 + 默认缓存策略（与 config/datasources.ts 完全对称）。
 *
 * 方案 A（当前静态绑定策略）：
 *   Service 编写时就固定声明 getCache("cache_default")，
 *   不按请求动态切换。若未来需要动态选择（如按租户路由到不同 Redis），
 *   可在 caches/registry.ts 内扩展 selectCacheByRequest(req)。
 */

import { getEnv, type CacheDecl } from "./env.js";

export type { CacheDecl } from "./env.js";

/** 启动时调用一次，拿到所有合法的缓存声明清单去 registry.registerAllCaches() */
export function getCacheDecls(): CacheDecl[] {
  return getEnv().caches;
}

/**
 * 默认「主」缓存名：
 *   优先找叫 "cache_default" 的；没找到就退回第一个声明的；
 *   还没有（连 .env 声明都没写）就返回 "cache_default"，
 *   注册中心 getCache() 会抛错（用户一看错误提示就知道要补 .env 声明）。
 */
export function getDefaultCacheName(): string {
  const cs = getEnv().caches;
  if (cs.length === 0) return "cache_default";
  const first = cs.find(c => c.name === "cache_default");
  return first ? first.name : cs[0].name;
}
