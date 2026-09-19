/**
 * 类型化 .env 解析（集中在一处，杜绝散落在各文件里的 process.env.xxx 直读）
 *
 * 数据源（DS_*）声明已废弃 —— 数据库连接信息现在存储在 object 表中（per-row）。
 * 此文件仅保留 JWT_SECRET / NODE_ENV / PORT / ADMIN_PATH + Redis 缓存声明解析。
 */

import type { CacheDecl } from "../caches/types.js";
export { type CacheDecl } from "../caches/types.js";

/** 数据源声明（内部使用：registry 构建 Datasource 实例 + adapter 构造函数参数） */
export interface DataSourceDecl {
  name: string;
  type: "sqlite" | "mysql" | "postgres";
  url?: string;
  path?: string;
  corsOrigins?: string[];
  corsMethods?: string[];
}

export interface EnvConfig {
  NODE_ENV: "development" | "production" | "test";
  PORT: number;
  ADMIN_PATH_RAW: string;
  caches: CacheDecl[];
  /** JWT 签名密钥（生产必须 32+ 位随机） */
  jwtSecret: string;
}

const REDIS_RE = /^REDIS_([A-Z0-9_]+)__(ENABLED|URL|DB|PASSWORD|KEY_PREFIX|CLUSTER)$/i;

/**
 * 解析 REDIS_<NAME>__* 命名。
 * 规则：
 *   - NAME 仅允许 [A-Z0-9_]，内部转小写；
 *   - __ENABLED=true  才会真正连接；缺省 = false（构建 Stub）
 *   - __URL=redis://user:pass@host:port/db  标准连接串
 *   - __DB=0 / __PASSWORD=xxx / __KEY_PREFIX=app:  / __CLUSTER=true  可选覆盖
 *
 * 全部缺省时返回 [] —— 注册中心会打 WARN 但不影响 HTTP 启动。
 */
function collectCaches(): CacheDecl[] {
  const byName = new Map<string, Partial<CacheDecl> & { name: string }>();
  for (const [rawK, rawV] of Object.entries(process.env)) {
    if (!rawK.startsWith("REDIS_") || rawV === undefined) continue;
    const m = REDIS_RE.exec(rawK);
    if (!m) continue;
    const nameRaw = m[1].toLowerCase();
    const key = m[2].toUpperCase() as
      "ENABLED" | "URL" | "DB" | "PASSWORD" | "KEY_PREFIX" | "CLUSTER";
    const cur = byName.get(nameRaw) ?? { name: nameRaw, type: "redis", enabled: false };
    switch (key) {
      case "ENABLED": {
        const v = rawV.trim().toLowerCase();
        cur.enabled = v === "true" || v === "1" || v === "yes";
        break;
      }
      case "URL":
        cur.url = rawV.trim();
        break;
      case "DB": {
        const n = Number(rawV.trim());
        if (!Number.isNaN(n)) cur.db = n;
        break;
      }
      case "PASSWORD":
        cur.password = rawV.trim();
        break;
      case "KEY_PREFIX":
        cur.keyPrefix = rawV.trim();
        break;
      case "CLUSTER": {
        const v = rawV.trim().toLowerCase();
        cur.cluster = v === "true" || v === "1" || v === "yes";
        break;
      }
    }
    cur.type = cur.type ?? "redis";
    byName.set(nameRaw, cur);
  }

  const result: CacheDecl[] = [];
  for (const c of byName.values()) {
    c.type = "redis";
    if (c.enabled && !c.url) {
      console.warn(
        `[config][cache] ${c.name}: __ENABLED=true 但缺少 __URL，` +
          `已自动降级为 enabled=false（Stub 不连），避免启动抛错。`
      );
      c.enabled = false;
    }
    result.push(c as CacheDecl);
  }
  return result;
}

let _cached: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (_cached) return _cached;
  const nodeEnvRaw = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
  const nodeEnv: EnvConfig["NODE_ENV"] =
    nodeEnvRaw === "production" || nodeEnvRaw === "test" ? nodeEnvRaw : "development";
  const jwtSecret = process.env.JWT_SECRET ?? "dev-secret-please-change-in-production-2026";
  _cached = {
    NODE_ENV: nodeEnv,
    PORT: Number(process.env.PORT ?? 8858),
    ADMIN_PATH_RAW: process.env.ADMIN_PATH ?? "/admin",
    caches: collectCaches(),
    jwtSecret
  };
  return _cached;
}

/** 测试专用：清空缓存（单测隔离） */
export function _resetEnvCache(): void {
  _cached = null;
}
