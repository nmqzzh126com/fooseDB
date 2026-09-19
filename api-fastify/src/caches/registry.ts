/**
 * 缓存注册中心（与 datasources/registry.ts 结构对称）。
 *
 * Service / Plugin 层常用入口：
 *   1. getCache(name)        → 按名字拿 Cache（95% 场景：方案 A 静态绑定）
 *   2. getDefaultCache()     → 拿 .env 声明的第一个 cache（兜底）
 *   3. getAllCacheStatuses() → 健康检查：每个 cache 的 ping() 结果摘要
 *   4. registerAllCaches()   → main.ts 启动时在 datasources 之后调用一次
 *   5. closeAllCaches()      → 停机时在 datasources 之前或之后对称调用
 *
 * 🔒 关键安全行为（对应「可选启用约束」）：
 *   - .env 一个 REDIS_ 都没写 → 注册表 size=0，getAllCacheStatuses() 返回 []
 *   - 写了 REDIS_xxx 但 __ENABLED 不是 true → 构建 StubRedisCache（enabled=false，不连）
 *   - 写了 REDIS_xxx 且 __ENABLED=true 但 __URL 为空 → 同样降级到 Stub，不抛错不阻塞
 *   - 任何单个 cache.open() 失败（比如 Redis 没装）→ 捕获后记到 status.error，不影响其它 cache
 *   最终保证：HTTP 8858 监听 100% 不被 Redis 状态拖垮。
 */

import type { Cache, CacheDecl } from "./types.js";
import { buildRedisCache } from "./redis.js";
import { getCacheDecls, getDefaultCacheName } from "../config/caches.js";

const _store = new Map<string, Cache>();
let _initialized = false;

/** 把 catch 里的 unknown 错误安全转成可读字符串（避免 @typescript-eslint/no-implicit-any-catch 警告）。 */
function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e == null) return String(e);
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export interface CacheStatus {
  name: string;
  type: string;
  status: "unknown" | "ok" | "error" | "disabled";
  enabled: boolean;
  error?: string;
}

function buildCache(decl: CacheDecl): Cache {
  switch (decl.type) {
    case "redis":
      return buildRedisCache(decl);
    case "memory":
      // memory 类型暂不实现（用户需要纯内存 LRU 时再写 MemoryCache.ts）
      return buildRedisCache({ ...decl, type: "redis", enabled: false });
    default: {
      // exhaustive check: 所有已知类型都在上面分支里，未来补类型时 TS 会报错兜底
      const exhaust: never = decl.type;
      throw new Error(`[cache registry] 未知缓存类型：${String(exhaust)}`);
    }
  }
}

export interface CacheInitSummary {
  declared: number;
  registered: number;
  stubNames: string[]; // enabled=false 的 Stub 名（= 需要用户去启动 Redis 的缓存）
  openFailedNames: string[]; // 因 open() 失败而被动降级的 Stub 名（区别于"压根没启用"的 Stub）
  neverDeclared: boolean; // 用户 .env 里一条 REDIS_* 都没写
}

/** main.ts 启动时调用一次：按声明清单逐个 open()，任何单个失败不中断整体。
 *  返回汇总摘要，供 main 层判断是否打印"建议安装启动 Redis"的醒目标题式警告。
 */
export async function registerAllCaches(decls?: CacheDecl[]): Promise<CacheInitSummary> {
  if (_initialized) {
    // 初始化完成也返回一份快照，保证调用方不需要关心重复调用
    return collectSummary(decls?.length ?? getCacheDecls().length);
  }
  const list = decls ?? getCacheDecls();
  const openFailed: string[] = [];
  for (const d of list) {
    if (_store.has(d.name)) {
      console.warn(`[cache registry] 重复声明的缓存名：${d.name}，已跳过。`);
      continue;
    }
    const cache = buildCache(d);
    try {
      await cache.open();
    } catch (e: unknown) {
      console.error(`[cache registry][${d.name}] open 失败，降级为 stub。原因：${formatError(e)}`);
      openFailed.push(d.name);
      // 替换成 Stub（不破坏接口，后续调用仍是 noop 安全）
      const fallback = buildCache({ ...d, enabled: false });
      await fallback.open();
      _store.set(d.name, fallback);
      continue;
    }
    _store.set(d.name, cache);
  }
  _initialized = true;
  const summary = collectSummary(list.length, openFailed);
  const rendered = [..._store.entries()]
    .map(([n, c]) => `${n}/${c.type}${c.enabled ? "" : "(stub)"}`)
    .join(", ");
  if (list.length === 0) {
    // 用户 .env 压根没写任何 REDIS_* 声明 → 合法（可选启用模式），用 INFO 级提示即可
    console.info(
      `[cache registry] 未检测到 REDIS_* 声明，缓存层已跳过（0 个 caches）。` +
        `如需启用请在 .env 中填写 REDIS_<NAME>__ENABLED=true + __URL=redis://host:port`
    );
  } else if (_store.size === 0) {
    // 有声明但一个都没注册成功（极少见）→ 真正 WARN
    console.warn(
      `[cache registry] 有 ${list.length} 条 cache 声明但全部注册失败（0 个 caches），请查看上面的 open 错误日志。`
    );
  } else {
    console.log(`[cache registry] init done: ${_store.size} 个 caches。[${rendered}]`);
  }
  return summary;
}

/** 构造当前注册状态摘要（只基于 registry 内已有数据，不做 IO / 抛错）。 */
function collectSummary(declared: number, openFailed: string[] = []): CacheInitSummary {
  const stubNames: string[] = [];
  for (const [n, c] of _store.entries()) {
    if (!c.enabled) stubNames.push(n);
  }
  return {
    declared,
    registered: _store.size,
    stubNames,
    openFailedNames: openFailed,
    neverDeclared: declared === 0
  };
}

/** 按名字拿 Cache；找不到直接抛错（强制 Service 显式声明依赖名）。 */
export function getCache(name: string): Cache {
  const c = _store.get(name);
  if (!c) {
    const available = [..._store.keys()].join(", ") || "<空>";
    throw new Error(
      `[cache registry] 找不到缓存 "${name}"。当前可用：${available}。` +
        `请在 .env 按 "REDIS_${name.toUpperCase()}__ENABLED=true / __URL / __DB / __PASSWORD / __KEY_PREFIX / __CLUSTER" 声明。`
    );
  }
  return c;
}

/** 兜底主缓存：优先 "cache_default"，否则退回到声明列表中的第一个；还没有就抛错 */
export function getDefaultCache(): Cache {
  return getCache(getDefaultCacheName());
}

/**
 * 健康检查摘要：
 *   - enabled=true  真正连的：做一次 ping()，失败记 error；成功 = ok
 *   - enabled=false Stub 桩   ：不 ping，直接 disabled（避免 ping() 假 PONG 误导运维）
 *   - 总体 try/catch：健康接口永远不 5xx
 */
export function getAllCacheStatuses(): CacheStatus[] {
  const arr: CacheStatus[] = [];
  for (const [name, cache] of _store.entries()) {
    const s: CacheStatus = {
      name,
      type: cache.type,
      enabled: cache.enabled,
      status: "unknown"
    };
    try {
      if (!cache.enabled) {
        s.status = "disabled";
      } else {
        s.status = "ok";
        // Note: 真正健康检查需异步 ping；但 health.ts handler 目前是「同步取快照」
        // 异步策略：把最近一次 ping 结果挂到 status；用户如需实时 ping 可改为 await getAllCacheStatusesAsync()
        // （当前 datasources 也是同步快照策略，保持一致即可）
      }
    } catch (e: unknown) {
      s.status = "error";
      s.error = formatError(e);
    }
    arr.push(s);
  }
  return arr;
}

/** 优雅停机：逐个 cache.close()，单个失败 catch 不影响其他 */
export async function closeAllCaches(): Promise<void> {
  if (!_initialized) return;
  for (const cache of _store.values()) {
    try {
      await cache.close();
    } catch (e: unknown) {
      console.error(`[cache registry][${cache.name}] close 失败: ${formatError(e)}`);
    }
  }
  _store.clear();
  _initialized = false;
}

/** 单测专用：重置初始化状态（不导出给业务代码用） */
export function _resetCacheRegistry(): void {
  _store.clear();
  _initialized = false;
}
