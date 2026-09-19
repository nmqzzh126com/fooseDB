/**
 * 缓存层统一接口（与 datasources/types.ts 的 Datasource 接口对称）。
 *
 * 所有方法强制返回 Promise，即使底层是同步 Map 也包一层 Promise，
 * 保证 Service 层签名完全一致：零修改即可切换 Redis / Memory / Stub。
 *
 * MVP 必选能力（Experience 1555229 分层裁剪）：
 *   String: get / set / del / exists / incr / decr
 *   TTL:    expire / getTtl
 *   生命周期: open / close / ping
 *
 * 可选高级能力（以「注释块示例」形式提供，不默认启用）：
 *   1. tryLock / tryUnlock — 分布式锁（Lua set NX PX + release）
 *   2. hashGet / hashSet / hashIncr — Hash 命令
 *   3. mget / mset — 批量命令
 */

export interface Cache {
  /** 缓存实例名称（注册中心 key）：cache_default / cache_ratelimit ... */
  readonly name: string;
  /** 底层类型：redis | memory | stub */
  readonly type: "redis" | "memory" | "stub";
  /** 是否已真正连接；false 表示所有方法走 noop（未声明 REDIS env 时） */
  readonly enabled: boolean;

  /** 建立连接（Registry.registerAllCaches 时自动调用） */
  open(): Promise<void>;
  /** 关闭连接（优雅停机自动调用） */
  close(): Promise<void>;
  /** 健康检查；失败时 throw，会被 registry 捕获并写入 status.error */
  ping(): Promise<"PONG">;

  /* ========== String 命令 ========== */
  get(key: string): Promise<string | null>;
  /** ttlSeconds >0 时会在 SET 后附加 EXPIRE；0 / undefined = 不过期 */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** 返回被删除的 key 数量 */
  del(...keys: string[]): Promise<number>;
  /** 1=存在；0=不存在 */
  exists(key: string): Promise<number>;
  /** by 默认 1；返回 increment 之后的新值 */
  incr(key: string, by?: number): Promise<number>;
  /** by 默认 1；返回 decrement 之后的新值 */
  decr(key: string, by?: number): Promise<number>;

  /* ========== TTL 命令 ========== */
  /** true=设置成功；false=key 不存在 */
  expire(key: string, seconds: number): Promise<boolean>;
  /** >=0: 剩余 TTL(秒)；-1: 无过期时间；-2: key 不存在 */
  getTtl(key: string): Promise<number>;
}

/**
 * .env 解析出的缓存声明（由 config/env.ts#collectCaches 产出）。
 * 命名规范：REDIS_<NAME>__ENABLED | __URL | __DB | __PASSWORD | __KEY_PREFIX | __CLUSTER
 * 其中 NAME 仅允许 [A-Z0-9_]，自动被转小写后作为注册中心 key。
 */
export interface CacheDecl {
  name: string;
  type: "redis" | "memory";
  /** false = registry 直接构建 StubCache（完全不连） */
  enabled: boolean;
  url?: string;
  db?: number;
  password?: string;
  keyPrefix?: string;
  /** true = 集群模式示例（用户需按注释块改 Redis 真实实现） */
  cluster?: boolean;
}
