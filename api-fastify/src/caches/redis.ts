/**
 * Redis 适配器（RealRedisCache = 真实 ioredis；StubRedisCache = 未启用兜底）
 *
 * ────────────────────────────────────────────
 * 🟢 当前状态：已启用真实 Redis（按用户 2026-09-01「按这个方案启用 Redis」的指令）：
 *   - 已安装 ioredis 6.0.0（pnpm add ioredis，已完成）
 *   - 已在 .env 中声明 REDIS_CACHE_DEFAULT__ENABLED=true + __URL=redis://127.0.0.1:6379
 *   - 已在本机启动 Redis 服务（tporadowski/redis 5.0 Windows zip，127.0.0.1:6379 PING→PONG）
 *   - 下方 class RealRedisCache 已取消注释并被 buildRedisCache 真正返回
 *
 * ────────────────────────────────────────────
 * 🟡 回退到「Stub 不连接」模式（如果将来用户希望临时禁用 Redis 但不想改 .env）：
 *   在本文件底部 buildRedisCache 中，把 return new RealRedisCache(decl) 改回
 *   return new StubRedisCache(decl.name, decl) 即可，Service 层调用签名零变化。
 *
 * ────────────────────────────────────────────
 * 🔴 降级策略（可选启用约束）：
 *   若 .env 没声明 REDIS_xxx → buildCache 不会走到本函数（buildRedisCache 仅被 registry.buildCache("redis") 调用）；
 *   若声明了但 enabled=false / url 缺 → 返回 StubRedisCache（本文件原有桩）；
 *   若 enabled=true 但 Redis 服务离线 → registry.registerAllCaches 内部 try/catch 会自动替换为 Stub，
 *     绝不阻塞 8858 监听，GET /health 仍返回 200 且对应 cache.status="disabled"。
 */

import { Redis, Cluster } from "ioredis";
import type { RedisOptions } from "ioredis";
import type { Cache, CacheDecl } from "./types.js";

/* ==========================================================================
 * 【桩实现】：当 enabled=false 或 URL 为空时返回此实例，保持签名但不做真实 IO
 * ========================================================================== */
export class StubRedisCache implements Cache {
  public readonly type = "stub" as const;
  public readonly enabled = false;
  constructor(
    public readonly name: string,
    public readonly decl: CacheDecl
  ) {}
  async open(): Promise<void> {
    /* noop */
  }
  async close(): Promise<void> {
    /* noop */
  }
  async ping(): Promise<"PONG"> {
    return "PONG";
  }
  async get(): Promise<string | null> {
    return null;
  }
  async set(_k: string, _v: string, _ttl?: number): Promise<void> {
    /* noop */
  }
  async del(..._keys: string[]): Promise<number> {
    return 0;
  }
  async exists(): Promise<number> {
    return 0;
  }
  async incr(_k: string, by = 1): Promise<number> {
    return by;
  }
  async decr(_k: string, by = 1): Promise<number> {
    return -by;
  }
  async expire(): Promise<boolean> {
    return false;
  }
  async getTtl(): Promise<number> {
    return -2;
  }
}

/* ==========================================================================
 * 【真实 Redis 实现（ioredis 6 兼容）】— 2026-09-01 已启用
 *   包含：单节点 + Cluster 分支；lazyConnect + connect() + ping() 保证可连通性；
 *   String MVP 命令 + TTL 命令 + 分布式锁 tryLock/tryUnlock 注释模板。
 * ========================================================================== */
export class RealRedisCache implements Cache {
  public readonly type = "redis" as const;
  public readonly enabled = true;
  public readonly name: string;
  private client: Redis | Cluster | null = null;
  private readonly opts: RedisOptions;

  constructor(public readonly decl: CacheDecl) {
    this.name = decl.name;
    const u = new URL(decl.url ?? "redis://127.0.0.1:6379");
    this.opts = {
      host: u.hostname || "127.0.0.1",
      port: Number(u.port) || 6379,
      username: u.username || undefined,
      password: (decl.password ?? u.password) || undefined,
      db: decl.db ?? (Number(u.pathname?.replace(/^\//, "")) || 0),
      keyPrefix: decl.keyPrefix ?? `${decl.name}:`,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true
      // 生产建议：retryStrategy(times){ return Math.min(times * 50, 2000); }
    };
  }

  async open(): Promise<void> {
    if (this.client) return;
    if (this.decl.cluster) {
      // 集群：URL 里写 1 个节点，ioredis 自动发现其余节点；多节点场景可扩展为 nodes[] 配置
      const node = { host: this.opts.host!, port: this.opts.port! };
      this.client = new Cluster([node], {
        redisOptions: this.opts,
        dnsLookup: (address, cb) => cb(null, address) // 禁用 DNS 反向解析（cluster 常见坑）
      });
    } else {
      this.client = new Redis(this.opts);
    }
    await (this.client as any).connect(); // lazyConnect + 显式连接一次
    await this.client.ping();
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } finally {
      this.client = null;
    }
  }

  async ping(): Promise<"PONG"> {
    if (!this.client) throw new Error("redis not open");
    const r = await this.client.ping();
    if (r !== "PONG") throw new Error(`redis ping unexpected reply: ${r}`);
    return "PONG";
  }

  // ————— String 命令 —————
  async get(key: string): Promise<string | null> {
    return (await this.client!.get(key)) ?? null;
  }
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client!.set(key, value, "EX", ttlSeconds);
    } else {
      await this.client!.set(key, value);
    }
  }
  async del(...keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    return this.client!.del(keys);
  }
  async exists(key: string): Promise<number> {
    return this.client!.exists(key);
  }
  async incr(key: string, by = 1): Promise<number> {
    return by === 1 ? this.client!.incr(key) : this.client!.incrby(key, by);
  }
  async decr(key: string, by = 1): Promise<number> {
    return by === 1 ? this.client!.decr(key) : this.client!.decrby(key, by);
  }
  // ————— TTL 命令 —————
  async expire(key: string, seconds: number): Promise<boolean> {
    return (await this.client!.expire(key, seconds)) === 1;
  }
  async getTtl(key: string): Promise<number> {
    return this.client!.ttl(key);
  }

  /* ========================================================================
   * 可选：分布式锁（Lua set NX PX + release）— 默认保留示例，随时可启用
   *
  async tryLock(lockKey: string, timeoutMs = 10000): Promise<string | null> {
    const token = Math.random().toString(36).slice(2);
    const ok = await this.client!.set(lockKey, token, "PX", timeoutMs, "NX");
    return ok === "OK" ? token : null;
  }
  async tryUnlock(lockKey: string, token: string): Promise<boolean> {
    const LUA_UNLOCK = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1])
      else return 0 end`;
    return (await this.client!.eval(LUA_UNLOCK, 1, lockKey, token)) === 1;
  }
   * ====================================================================== */
}

/**
 * 对外工厂：按声明返回 Stub（未启用 / URL 缺）或 RealRedisCache（已启用）
 *   - enabled=false 或 url 空 → Stub（兜底 noop）
 *   - enabled=true 且 url 有值 → RealRedisCache（真正 ioredis，open() 时 connect+ping）
 *   - 如果启用了但 Redis 服务离线，registry 会在 registerAllCaches 内部捕获 open() 抛错，
 *     自动替换回 Stub，绝不影响 8858 启动。
 */
export function buildRedisCache(decl: CacheDecl): Cache {
  if (!decl.enabled || !decl.url) {
    return new StubRedisCache(decl.name, decl);
  }
  // ✅ 2026-09-01 启用真实 Redis（回退：改回 StubRedisCache 即可）
  return new RealRedisCache(decl);
}
