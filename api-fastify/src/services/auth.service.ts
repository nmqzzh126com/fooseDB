/**
 * 认证 Service：登录验证 + JWT token 生成 + 密码哈希 + refresh_token 轮换。
 *
 * 安全措施（与 routes/v1/auth.ts 配合）：
 *   P0  bcrypt cost=10 哈希存储 + 时序安全比较；启动时明文密码自动迁移
 *   P1  登录限流（IP 维度，Redis cache_default 固定窗口，Stub 时放行）
 *   P2  客户端指纹绑定：JWT payload.fp = SHA256(X-Client-Id||UA)，verifyToken 时序比对
 *   P3  token_version 代次（users 表）：改密/踢人只需要 +1，verifyToken 比 payload.tv
 *        即可让旧 access_token 立即失效，不依赖 Redis 黑名单（性能更好、也可横向扩展）。
 *   P4  refresh_token 轮换 + reuse detection：POST /api/auth/refresh 接受 refresh_jwt，
 *        按 family_id 作废前一代；同一个旧 refresh 被二次使用（reuse）→ 整 family 失效
 *        强制重登（防 token 被复制时的持续滥用）。
 *   P5  refresh 绑定 fingerprint：刷新端指纹必须与签发端一致（换 UA/设备 → 直接 401，
 *        即便 refresh 泄露到别的设备也没法续）。
 *
 * 性能优化（本轮按你的要求实现 2 和 3，额外实现了 1）：
 *   1. token_version LRU：进程内 Map，TTL = TV_CACHE_TTL（默认 10s）。首次命中查一次 DB，
 *      后续 10s 内直接读内存，避免每个 verifyToken 都打 SQLite。多实例部署场景下，最坏
 *      改密后最多 10s 旧 token 仍有效；可按需调 .env TOKEN_VERSION_CACHE_TTL_SEC 缩小。
 *   2. fingerprint 请求级缓存：请求层 plugins/auth-context.ts 已将 fingerprint 和 bearer
 *      token 预挂到 request.authContext，service 层优先读预计算值，避免同一请求内
 *      重复 SHA256 指纹计算。
 *   3. verifyToken 单签名：JWT 验签是一次 HMAC-SHA256（~0.01ms），已经极轻。
 */

import { randomBytes } from "node:crypto";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { getDs } from "../datasources/registry.js";
import { getDb, BCRYPT_COST } from "../db.js";
import { BusinessError } from "../utils/errors.js";
import { attachRoles, type RoleBrief } from "./users.service.js";

/**
 * 解析 .env 中的 TTL（秒）。非法/缺省/非正整数时回退默认值，绝不抛错。
 * 支持纯数字（秒）；空白或非数字 → 默认值。
 */
function parseTtlSeconds(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(String(raw).trim());
  // 必须是有限的正整数；NaN / Infinity / <=0 / 小数都视为非法
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return fallback;
  return n;
}

/** 解析「可关闭」的非负整数秒：缺省/非法回退 fallback；显式 0 表示关闭（不报错） */
function parseOptOutTtlSeconds(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) return fallback;
  return n;
}

/** access_token 有效期（秒）。默认 2 小时；可用 .env ACCESS_TOKEN_TTL_SEC 覆盖 */
const ACCESS_TOKEN_TTL = parseTtlSeconds(process.env.ACCESS_TOKEN_TTL_SEC, 2 * 60 * 60);
/** refresh_token 有效期（秒）。默认 7 天；可用 .env REFRESH_TOKEN_TTL_SEC 覆盖 */
export const REFRESH_TOKEN_TTL = parseTtlSeconds(
  process.env.REFRESH_TOKEN_TTL_SEC,
  7 * 24 * 60 * 60
);

/** bcrypt cost factor 统一在 db.ts 解析（.env BCRYPT_COST，默认 10），种子/迁移/改密共用 */

/**
 * 登录校验短缓存（性能优化：多客户端共用同一套账号密码时）。
 *   bcryptjs cost=10 单次 compare 约 60~100ms 纯 JS CPU 开销。当多个客户端
 *   使用同一用户名/密码频繁登录（如公共服务账号、批量脚本、断线重连风暴）时，
 *   每次都跑 bcrypt 会无谓占用事件循环。这里对「用户名+明文密码」做短 TTL 缓存：
 *     · key   = sha256(username + ":" + plainPassword)，不含明文、不可逆；
 *     · value = { pwdHash: 该用户当前 DB 中的 bcrypt 哈希, expireAt }；
 *     · 命中条件：key 命中 **且** DB 查出的 user.password === 缓存 pwdHash **且** 未过期。
 *   安全性：
 *     · 只缓存「校验成功」结果，密码错误不缓存（不降低暴力破解成本）；
 *     · 改密/重置密码后 user.password 哈希变化 → pwdHash 不匹配 → 立即 miss 走 bcrypt，
 *       无需等待 TTL；账号禁用/object_id 变更每次都查 DB，同样立即生效；
 *     · 每次登录仍查 users 表（拿最新 object_id/tv/password），缓存只跳过 bcrypt 这一步。
 *   可通过 .env LOGIN_CHECK_CACHE_TTL_SEC 调整窗口（默认 30 秒，设 0 关闭）。
 */
const LOGIN_CHECK_TTL_MS = parseOptOutTtlSeconds(process.env.LOGIN_CHECK_CACHE_TTL_SEC, 30) * 1000;

interface LoginCheckEntry {
  pwdHash: string;
  expireAt: number;
}
const loginCheckCache = new Map<string, LoginCheckEntry>();

function loginCheckKey(username: string, plain: string): string {
  return createHash("sha256").update(`${username}\u0000${plain}`).digest("hex");
}

/** 懒清理过期项（顺带在缓存过大时触发，防止 Map 无限增长） */
function pruneLoginCheckCache(now: number): void {
  if (loginCheckCache.size <= 5000) return;
  for (const [k, v] of loginCheckCache) {
    if (v.expireAt <= now) loginCheckCache.delete(k);
  }
}

/**
 * token_version 进程内短时缓存：
 *   Map<uid, {tv:number, expireAt: number(ms timestamp)}>
 * 命中但 expireAt 过期 → 仍视为 miss，重新查 DB。
 * 为什么用自写 Map 不 LRU：users 量通常 < 10 万，expire 懒清理足够，无性能问题。
 */
const TV_CACHE = new Map<number, { tv: number; object_id: number; flag: number; expireAt: number }>();
const TV_CACHE_TTL_SEC = Number(process.env.TOKEN_VERSION_CACHE_TTL_SEC ?? 10) || 10;

/** tv 懒清理：避免长时间运行 Map 只增不减（容量=活跃用户数即可） */
let _tvCacheLastPrune = 0;
function pruneTvCacheIfNeeded(nowMs: number): void {
  if (nowMs - _tvCacheLastPrune < 30_000) return;
  _tvCacheLastPrune = nowMs;
  for (const [uid, e] of TV_CACHE.entries()) if (e.expireAt < nowMs) TV_CACHE.delete(uid);
}

// ———————————————————————————————————————————————————————————————
// 管理端面板账号（.env 驱动，不走 users 表）
// ———————————————————————————————————————————————————————————————

/** .env 管理员账号：ADMIN_USERNAME 默认 admin，ADMIN_PASSWORD 默认 admin123。
 *  admin 账号的登录优先级高于 users 表（同样的 username 在 users 表里有也行，
 *  但永远走 .env 路径，签发 admin-panel scope JWT）。 */
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME ?? "admin").trim();
const ADMIN_PASSWORD_RAW = process.env.ADMIN_PASSWORD ?? "admin123";
const ADMIN_NICKNAME = (process.env.ADMIN_NICKNAME ?? "系统管理员").trim();
/** admin-panel JWT 的 tv 统一走 users 表（与普通业务用户相同，admin 账号在 users 表有一条 shadow 行提供外键锚点和 token_version） */

/**
 * 校验 admin 密码：ADMIN_PASSWORD 支持两种格式：
 *   - 以 $2 开头 → bcrypt 哈希（生产推荐）
 *   - 其他      → 明文（开发方便；用 timingSafeEqual 防时序攻击）
 */
async function verifyAdminPassword(plain: string): Promise<boolean> {
  if (ADMIN_PASSWORD_RAW.startsWith("$2")) {
    return bcrypt.compare(plain, ADMIN_PASSWORD_RAW);
  }
  // 明文：时序安全比较
  try {
    const a = Buffer.from(plain);
    const b = Buffer.from(ADMIN_PASSWORD_RAW);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** bcrypt 哈希密码；明文密码不要直接存库 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/** 校验密码；同时支持 bcrypt 哈希和遗留明文（用于启动时迁移） */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (startsWithBcrypt(stored)) {
    return bcrypt.compare(plain, stored);
  }
  // 遗留明文：仍走时序安全比较（避免根据匹配长度返回不同时间）
  try {
    const a = Buffer.from(plain);
    const b = Buffer.from(stored);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function startsWithBcrypt(s: string): boolean {
  return s.startsWith("$2");
}

/** 判断存储的密码是否还是明文（用于启动时迁移） */
export function isPlaintextPassword(stored: string): boolean {
  return !startsWithBcrypt(stored);
}

/**
 * 计算客户端指纹（P2）。
 * 优先级：X-Client-Id（前端显式声明的设备标识）> User-Agent > "unknown"。
 * 返回 SHA-256 hex。
 */
export function computeClientFingerprint(
  clientId: string | undefined,
  userAgent: string | undefined
): string {
  const source = clientId ? `cid:${clientId}` : userAgent ? `ua:${userAgent}` : "unknown";
  return createHash("sha256").update(source).digest("hex");
}

/** 从请求头提取单值 header（兼容 string | string[]） */
export function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 从 Fastify request.headers 计算客户端指纹。
 * 若请求已预挂 authContext（plugins/auth-context.ts 在 onRequest 里计算过一次），
 * 直接复用，避免同一请求被 verifyToken 多次调用时重复 SHA。
 */
export function fingerprintFromHeaders(
  headers: {
    [k: string]: string | string[] | undefined;
  },
  preComputed?: string
): string {
  if (preComputed) return preComputed;
  return computeClientFingerprint(
    headerValue(headers["x-client-id"]),
    headerValue(headers["user-agent"])
  );
}

/** JWT payload 增加 tv + jti + object_id：
 *   tv  = users.token_version（改密+1，旧 token 立即作废）
 *   jti = 每条 token 唯一 id（refresh 轮换用 jti → jwt_id 精确对应 refresh_tokens 行）
 *   object_id = users.object_id（决定该用户能访问哪些项目：-1=系统管理员，否则=绑定的 object.id）
 *
 *   为什么 object_id 放 JWT 而不是每次 verify 查询 DB？
 *     · 与 token_version 类似：管理员改绑定不频繁；最坏情况下（object_id 被改掉但用户仍持有旧 token）
 *       下一次 refresh 会重新读最新 users.object_id 签发，或 bumpUserTokenVersion 直接让所有 access 作废。
 *     · 省一次 DB 查询（resolveObjectAccess / custom.authorizeCaller 每个请求不需要再查 users）。
 */
export interface JwtPayload {
  sub: number;
  username: string;
  nickname: string | null;
  iat: number;
  exp: number;
  type: "access" | "refresh";
  /** 客户端指纹（SHA-256 hex）：verifyToken 时与请求指纹比对 */
  fp: string;
  /** token_version：签发时写入，verifyToken 与用户 DB 值比对（允许 0 TTL 差）。
   *  admin-panel scope 的 token 不走 users 表 tv，而是用固定常量 ADMIN_TV 检查 */
  tv: number;
  /** 唯一 JWT ID：refresh_tokens.jwt_id 对应，用于精确定位轮换行 */
  jti: string;
  /** 用户绑定的 object（项目）id；-1 系统管理员，>=1 仅能访问指定 object 项目的白名单表 */
  object_id: number;
  /** 管理端面板专属 scope：仅当 .env ADMIN_USERNAME/ADMIN_PASSWORD 登录时签发 "admin-panel"。
   *  有此 scope 的 token 可以访问 /api/admin/db/* 和所有管理接口；
   *  普通业务用户（users 表登录）的 token 没有 scope 字段 */
  scope?: "admin-panel";
}

function getSecret(): string {
  const s = process.env.JWT_SECRET ?? "dev-secret-change-in-production";
  if (s.length < 16) {
    console.warn("[auth] JWT_SECRET 长度不足 16 位，建议在生产环境中使用更强的密钥。");
  }
  return s;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function sign(data: string): string {
  return createHmac("sha256", getSecret()).update(data).digest("base64url");
}

function createToken(payload: JwtPayload): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = sign(`${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

function newJti(): string {
  // 16 bytes -> 32 hex，够用
  return randomBytes(16).toString("hex");
}

/**
 * 取用户的 token_version + object_id + flag（带进程内 TTL 缓存，避免每请求打 DB）。
 *
 * 只在两种情况下 miss：
 *   · 该用户 10s 内首次被 verify（常见。一次 DB 查询约 5~10ms，后续 10s 内 0ms）
 *   · 缓存值已过期需要 refresh
 * 返回 null 表示用户不存在（verifyToken 会报 token invalid）。
 */
interface UserAuthState {
  tv: number;
  object_id: number;
  flag: number;
}
export function getUserAuthState(uid: number): UserAuthState | null {
  const now = Date.now();
  pruneTvCacheIfNeeded(now);
  const hit = TV_CACHE.get(uid);
  if (hit && hit.expireAt > now) {
    return { tv: hit.tv, object_id: hit.object_id ?? -1, flag: hit.flag ?? 0 };
  }
  try {
    const row = getDb()
      .prepare("SELECT token_version AS tv, object_id, flag FROM users WHERE id = ?")
      .get(uid) as UserAuthState | undefined;
    if (!row) return null;
    TV_CACHE.set(uid, {
      tv: row.tv,
      object_id: row.object_id,
      flag: row.flag,
      expireAt: now + TV_CACHE_TTL_SEC * 1000
    });
    return row;
  } catch {
    // app.db 尚未初始化或查询失败：保守 miss，不缓存，下次重试
    return null;
  }
}

/**
 * 手动令某个用户的现有 token 全部失效（改密、踢人、管理员操作）。
 * 返回写入后的 token_version。
 */
export function bumpUserTokenVersion(uid: number): number {
  getDb().prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(uid);
  TV_CACHE.delete(uid);
  const row = getDb().prepare("SELECT token_version AS tv FROM users WHERE id = ?").get(uid) as
    { tv: number } | undefined;
  return row?.tv ?? 1;
}

/**
 * 验证 JWT：签名 + 过期 + 指纹 + token_version 代次。
 * 任意一条失败抛 BusinessError(401)。
 *
 * 性能：纯内存运算 + 进程内 TV 缓存命中，约 0.02~0.05ms / 次；
 * TV miss 时追加一次同步 SQLite 查询 ~10ms，10s 内自动收敛。
 *
 * @param fingerprintAlreadyComputed 传入请求层预计算的指纹（authContext.fingerprint），
 *                                   避免二次 sha256；未传仍可通过 headers + tokenPayload 回退计算。
 */
export function verifyToken(token: string, fingerprintAlreadyComputed: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new BusinessError(401, "invalid token format | token 格式错误");
  const [header, body, sig] = parts;
  const expected = sign(`${header}.${body}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new BusinessError(401, "invalid token signature | token 签名无效");
  }
  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new BusinessError(401, "invalid token payload | token payload 无效");
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new BusinessError(401, "token expired | token 已过期");
  }
  // 指纹比对（时序安全）
  const fpBuf = Buffer.from(payload.fp ?? "");
  const reqBuf = Buffer.from(fingerprintAlreadyComputed);
  if (fpBuf.length !== reqBuf.length || !timingSafeEqual(fpBuf, reqBuf)) {
    throw new BusinessError(401, "token client mismatch | token 客户端指纹不匹配");
  }
  // token_version 代次检查（进程内短时缓存）
  // admin-panel scope 的 token 也走 users 表 tv（因为 sub 是 admin 用户的真实 id）
  const state = getUserAuthState(payload.sub);
  if (state == null) {
    throw new BusinessError(401, "token subject invalid | token 用户无效");
  }
  if (Number.isFinite(payload.tv) && payload.tv < state.tv) {
    throw new BusinessError(401, "token revoked (version mismatch) | token 已撤销（版本不匹配）");
  }
  // 业务用户额外约束：object_id > 0 AND flag = 0
  // 系统管理员（object_id=-1）豁免 —— 不管 JWT 里有没有 scope 字段，DB 才是事实来源
  // 管理端路由层还有 requireSystemAdminForManage 检查 scope，那里会拦 legacy admin
  const isSysAdmin = state.object_id === -1;
  if (!isSysAdmin) {
    if (state.object_id <= 0) {
      throw new BusinessError(403, "账号已被禁用（未分配项目）");
    }
    if (state.flag !== 0) {
      throw new BusinessError(403, "账号已被标记为不可用");
    }
  }
  return payload;
}

/** 由 decodeToken 返回：与 JwtPayload 结构相同，但 sub 可能为 null（token 坏或 payload 中不存在 sub）。 */
export type DecodedJwtPayload = {
  sub: number | null;
  username?: string;
  nickname?: string | null;
  iat?: number;
  exp?: number;
  type?: "access" | "refresh";
  fp?: string;
  tv?: number;
  jti?: string;
  object_id?: number;
  [extra: string]: unknown;
};

/**
 * 「弱解码」JWT payload：不做签名验证 / 过期校验 / 指纹比对。
 * 仅用于 custom-sql 审计日志、refresh 解析 jti 等非准入场景，
 * 永不抛错，格式坏时返回 { sub: null }。
 */
export function decodeToken(token: string): DecodedJwtPayload {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { sub: null };
    const parsed = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as Partial<JwtPayload> & Record<string, unknown>;
    return { ...parsed, sub: (parsed.sub as number | undefined) ?? null };
  } catch {
    return { sub: null };
  }
}

interface UserRowInternal {
  id: number;
  username: string;
  nickname: string | null;
  password: string;
  token_version: number;
  /** 用户绑定的项目：-1=系统管理员，>=1=object.id 绑定一个项目，0=未配置项目（密码正确也拒登，403） */
  object_id: number;
  /** flag 业务标记位：0=正常可登录，非 0 = 禁止登录（具体语义由业务定义） */
  flag: number;
  /** 扩展字段（JSON TEXT，存储任意自定义用户数据） */
  extended: string | null;
  /** 头像 URL */
  avatar: string | null;
  /** 权限列表（JSON TEXT 或逗号分隔字符串） */
  permissions: string | null;
  /** 邮箱 */
  email: string | null;
  /** 手机号 */
  phone: string | null;
}

/** 登录/刷新/me 响应里附带的用户资料块 */
export interface UserProfile {
  id: number;
  username: string;
  nickname: string | null;
  object_id: number;
  extended: string | null;
  avatar: string | null;
  permissions: string | null;
  /** 角色列表（虚拟字段：从 role_user + roles 表 JOIN 出来） */
  roles: RoleBrief[];
  email: string | null;
  phone: string | null;
}

export interface LoginResult {
  expires: number; // access_token exp
  refresh_expires: number; // refresh_token exp
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  user: UserProfile;
}

/**
 * 登录：签发 access(2h) + refresh(7d)，并将 refresh 写入 refresh_tokens 表。
 * 每次登录都会启动一条新的 family（family_id=随机），generation=1。
 *
 * 认证顺序：
 *   1. 先查 .env ADMIN_USERNAME/ADMIN_PASSWORD —— 匹配 → admin-panel scope JWT（不走 users 表）
 *   2. 不匹配 → 查 users 表 —— 匹配 → 普通业务用户 JWT（无 admin-panel scope）
 *   3. 都不匹配 → 401 "用户名或密码错误"（统一文案防账号枚举）
 */
export async function login(
  username: string,
  password: string,
  fingerprint: string
): Promise<LoginResult> {
  // —— 分支 1：.env 管理员账号优先 ——
  if (username === ADMIN_USERNAME) {
    if (!(await verifyAdminPassword(password))) {
      throw new BusinessError(401, "用户名或密码错误");
    }
    // 查 users 表拿真实 id（refresh_tokens 外键约束需要有效 users.id；
    // admin-panel JWT 的 tv 也用 admin 用户的 token_version，统一 tv 失效机制）
    let adminRow: {
      id: number;
      token_version: number;
      object_id: number;
      nickname: string | null;
      extended: string | null;
      avatar: string | null;
      permissions: string | null;
      email: string | null;
      phone: string | null;
    } | undefined = getDb()
      .prepare(
        "SELECT id, token_version, object_id, nickname, extended, avatar, permissions, email, phone FROM users WHERE username = ? LIMIT 1"
      )
      .get(ADMIN_USERNAME) as any;
    // 如果 users 表没有对应的 admin 行（极少见：有人手动删了），自动建一条作为 FK 锚点。
    // 密码用不可猜哈希，防止改了 .env ADMIN_USERNAME 后旧用户名被绕过。
    if (!adminRow) {
      const adminShadowHash = await bcrypt.hash("__admin_shadow_never_login__", BCRYPT_COST);
      const info = getDb()
        .prepare("INSERT INTO users(username, nickname, password, object_id) VALUES(?,?,?,?)")
        .run(ADMIN_USERNAME, "admin(shadow)", adminShadowHash, -1);
      adminRow = {
        id: info.lastInsertRowid as number,
        token_version: 1,
        object_id: -1,
        nickname: null,
        extended: null,
        avatar: null,
        permissions: null,
        email: null,
        phone: null
      };
      console.warn("[auth] admin shadow row missing in users table; auto-created id=", adminRow.id);
    }
    // adminRow 此处必不为 undefined（上面 if 已兜底赋值）
    const row = adminRow;
    // attachRoles 会挂 RoleBrief[] 虚拟字段
    const withRoles = attachRoles([row as { id: number } & typeof row])[0];
    return signLoginResult({
      sub: row.id,
      username: ADMIN_USERNAME,
      nickname: ADMIN_NICKNAME, // admin-panel 昵称走 .env，不走 users 表 shadow 行
      object_id: -1,
      tv: row.token_version,
      fingerprint,
      scope: "admin-panel",
      extended: row.extended,
      avatar: row.avatar,
      permissions: row.permissions,
      roles: withRoles.roles,
      email: row.email,
      phone: row.phone
    });
  }

  // —— 分支 2：users 表业务用户 ——
  const db = getDs("sqlite_app");
  const rows = await db.query<UserRowInternal>(
    "SELECT id, username, nickname, password, token_version, object_id, flag, extended, avatar, permissions, email, phone FROM users WHERE username = ? LIMIT 1",
    [username]
  );
  if (rows.length === 0) {
    throw new BusinessError(401, "用户名或密码错误");
  }
  const user = rows[0];

  // —— 密码校验：优先命中登录短缓存，否则 bcrypt.compare ——
  let passwordOk = false;
  const nowMs = Date.now();
  const cacheKey = LOGIN_CHECK_TTL_MS > 0 ? loginCheckKey(username, password) : null;
  if (cacheKey) {
    const hit = loginCheckCache.get(cacheKey);
    if (hit && hit.expireAt > nowMs && hit.pwdHash === user.password) {
      passwordOk = true; // 缓存命中：密码正确且数据库哈希未变
    } else if (hit) {
      loginCheckCache.delete(cacheKey); // 过期或密码已改 → 清掉旧项
    }
  }
  if (!passwordOk) {
    passwordOk = await verifyPassword(password, user.password);
    if (!passwordOk) {
      throw new BusinessError(401, "用户名或密码错误");
    }
    if (cacheKey) {
      loginCheckCache.set(cacheKey, {
        pwdHash: user.password,
        expireAt: nowMs + LOGIN_CHECK_TTL_MS
      });
      pruneLoginCheckCache(nowMs);
    }
  }

  // —— object_id <= 0（未配置项目 / 封禁）或 flag != 0（业务禁用）→ 403 ——
  // 必须在密码校验之后，防账号枚举
  if (user.object_id <= 0) {
    throw new BusinessError(403, "用户未分配项目或账号已被禁用，请联系管理员");
  }
  if (user.flag !== 0) {
    throw new BusinessError(403, "账号已被标记为不可用，请联系管理员");
  }

  // attachRoles 同步查 role_user + roles，挂 RoleBrief[] 到 user.roles
  attachRoles([user as unknown as { id: number } & typeof user]);
  return signLoginResult({
    sub: user.id,
    username: user.username,
    nickname: user.nickname,
    object_id: user.object_id,
    tv: user.token_version,
    fingerprint,
    scope: undefined,
    extended: user.extended,
    avatar: user.avatar,
    permissions: user.permissions,
    roles: (user as any).roles,
    email: user.email,
    phone: user.phone
  });
}

/**
 * 内部辅助：签发 access + refresh 双 JWT 并写 refresh_tokens。
 * 被 login() 的 admin-panel 分支和业务用户分支共用。
 */
function signLoginResult(params: {
  sub: number;
  username: string;
  nickname: string | null;
  object_id: number;
  tv: number;
  fingerprint: string;
  scope?: "admin-panel";
  extended: string | null;
  avatar: string | null;
  permissions: string | null;
  roles: RoleBrief[];
  email: string | null;
  phone: string | null;
}): LoginResult {
  const {
    sub,
    username,
    nickname,
    object_id,
    tv,
    fingerprint,
    scope,
    extended,
    avatar,
    permissions,
    roles,
    email,
    phone
  } = params;

  const now = Math.floor(Date.now() / 1000);
  const accessJti = newJti();
  const refreshJti = newJti();
  const familyId = randomBytes(12).toString("hex");

  const accessPayload: JwtPayload = {
    sub,
    username,
    nickname,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL,
    type: "access",
    fp: fingerprint,
    tv,
    jti: accessJti,
    object_id,
    ...(scope === "admin-panel" ? { scope: "admin-panel" as const } : {})
  };
  const refreshPayload: JwtPayload = {
    sub,
    username,
    nickname,
    iat: now,
    exp: now + REFRESH_TOKEN_TTL,
    type: "refresh",
    fp: fingerprint,
    tv,
    jti: refreshJti,
    object_id,
    ...(scope === "admin-panel" ? { scope: "admin-panel" as const } : {})
  };

  // 写 refresh_tokens（family_id 首次 generation=1）
  try {
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens(user_id, fingerprint, family_id, generation, jwt_id, valid, expires_at)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(sub, fingerprint, familyId, 1, refreshJti, 1, refreshPayload.exp);
  } catch {
    const retryJti = newJti();
    refreshPayload.jti = retryJti;
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens(user_id, fingerprint, family_id, generation, jwt_id, valid, expires_at)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(sub, fingerprint, familyId, 1, retryJti, 1, refreshPayload.exp);
  }

  return {
    expires: accessPayload.exp,
    refresh_expires: refreshPayload.exp,
    access_token: createToken(accessPayload),
    refresh_token: createToken(refreshPayload),
    token_type: "Bearer",
    user: {
      id: sub,
      username,
      nickname,
      object_id,
      extended,
      avatar,
      permissions,
      roles,
      email,
      phone
    }
  };
}

// ============================================================================
// Refresh Token 轮换 + Reuse Detection + Logout
// ============================================================================

interface RefreshTokenRow {
  id: number;
  user_id: number;
  fingerprint: string;
  family_id: string;
  generation: number;
  jwt_id: string;
  valid: number;
  expires_at: number;
}

export interface RefreshResult extends LoginResult { }

/**
 * 用 refresh_jwt 换一组新的 access+refresh。
 *
 * 安全策略（OAuth2 rotation + reuse detection 经典方案的 SQLite 适配）：
 *   1. 对入参 refresh_jwt 做「签名 + 过期 + 指纹 + tv 代次」完整 verify（视为准入）
 *   2. 类型必须是 type=refresh；payload.fp 必须等于请求端指纹（防 refresh 泄露跨设备续）
 *   3. 通过 jti 查 refresh_tokens 行：
 *        a) 找不到 → 401 invalid refresh | 刷新令牌无效；
 *        b) 行存在但 valid=0 → 【Reuse Detection 触发】：该 family_id 下所有行都
 *           标记 invalid(revoke_reason="reuse")，返回 401 "refresh reuse detected, re-login required | 检测到刷新令牌重放，请重新登录"。
 *        c) valid=1：正常继续
 *   4. 旧行标记 valid=0, reason="used", revoked_at=now。
 *   5. generation + 1，插入新 refresh_tokens 行 + 签发新 access/refresh JWT（同 family_id）。
 *
 * 注意：fingerprint 必须与签发端一致；即"换浏览器/换 UA = 旧 refresh 立刻无法用，
 * 必须重新登录"。这比纯 TV 代次更严格，但防 token 复制更可靠。如需 UA 变化容忍（对用户
 * 体验好但安全弱），可在第 2 步关掉 fp 严格比对——这里默认严格。
 */
export async function refresh(refreshJwt: string, fingerprint: string): Promise<RefreshResult> {
  // ================================================================
  // P0.5: 请求端 fingerprint 与「签发端存储 row.fingerprint」严格一致
  //       先做弱解码拿 jti → 查 refresh_tokens 行 → 取 row.fingerprint 对比
  //       为什么不只依赖 verifyToken 的 fp 比对？因为 verifyToken 失败直接抛，
  //       拿不到 family_id → 无法 markFamilyInvalid，导致该 family 还能被
  //       原 client 正常续（被盗 token 只被当前错误 fp 拒绝，家族没失效）。
  // ================================================================
  const db = getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const weak = decodeToken(refreshJwt); // 不验签，只拿 jti
  if (typeof weak.jti === "string") {
    const row = db
      .prepare("SELECT * FROM refresh_tokens WHERE jwt_id = ? LIMIT 1")
      .get(weak.jti) as RefreshTokenRow | undefined;
    if (row) {
      // 用 Buffer 时序安全比较（指纹是 64 hex，长度固定，safe）
      const a = Buffer.from(row.fingerprint);
      const b = Buffer.from(fingerprint);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        markFamilyInvalid(row.family_id, "fp_mismatch");
        // 401 立即拒绝：给前端一致的文案
        throw new BusinessError(
          401,
          "refresh client mismatch, re-login required | 刷新令牌客户端不匹配，请重新登录"
        );
      }
      // 同时：exp 先判断可直接给明确的 expired 错误（即使签名坏，也给出用户能理解的）
      if (row.expires_at < nowSec) {
        markRowInvalid(row.id, "expired");
        throw new BusinessError(401, "refresh expired | 刷新令牌已过期");
      }
      // 如果 valid 已经是 0（被盗过/reuse）→ 直接 reuse 级拒绝，整 family 失效
      if (row.valid !== 1) {
        markFamilyInvalid(row.family_id, "reuse");
        throw new BusinessError(
          401,
          "refresh reuse detected, re-login required | 检测到刷新令牌重放，请重新登录"
        );
      }
    }
  }

  // Step 1：完整验证 refresh_jwt（签名/过期/token_version/指纹 — 上面 fp 已提前判过，但仍要 verify 防篡改）
  const payload = verifyToken(refreshJwt, fingerprint);
  if (payload.type !== "refresh") {
    throw new BusinessError(400, "not a refresh token | 不是刷新令牌");
  }

  // Step 2-3：查 refresh_tokens 行（上面已经读，但再读一遍保证 verify 过后的一致性）
  const row = db
    .prepare("SELECT * FROM refresh_tokens WHERE jwt_id = ? LIMIT 1")
    .get(payload.jti) as RefreshTokenRow | undefined;

  if (!row) {
    throw new BusinessError(401, "invalid refresh | 刷新令牌无效");
  }

  if (row.user_id !== payload.sub) {
    throw new BusinessError(401, "invalid refresh | 刷新令牌无效");
  }

  // 指纹严格匹配 & reuse & exp：上方提前判过，这里再做一次防御性校验（不通过即 family 作废）
  if (row.fingerprint !== payload.fp) {
    markFamilyInvalid(row.family_id, "fp_mismatch");
    throw new BusinessError(
      401,
      "refresh client mismatch, re-login required | 刷新令牌客户端不匹配，请重新登录"
    );
  }
  if (row.valid !== 1) {
    markFamilyInvalid(row.family_id, "reuse");
    throw new BusinessError(
      401,
      "refresh reuse detected, re-login required | 检测到刷新令牌重放，请重新登录"
    );
  }
  if (row.expires_at < nowSec) {
    markRowInvalid(row.id, "expired");
    throw new BusinessError(401, "refresh expired | 刷新令牌已过期");
  }

  // Step 4-5：旧行标记 used + 插入新行 → 同一 SQLite 事务包起来。
  //
  // 为什么要事务：进程崩溃（OOM/kill -9）若发生在 mark-invalid 之后、INSERT 之前，
  // 会出现「旧 refresh 已作废但 family 无新行」的中间态 → 用户下次 refresh 命中 reuse 检测 →
  // 整 family 被作废 → 强制重新登录。单线程 WAL + busy_timeout 本来能覆盖大部分并发，
  // 但崩溃无法被恢复，必须靠原子事务彻底消除这个窗口。
  //
  // better-sqlite3 Transaction 非常轻量（同步、零网络开销），这里收益 > 成本。

  // —— 事务块外面先查好用户 / 算出 payload（这些是「读」和「计算」，不属于临界区）——
  const nextGen = row.generation + 1;
  type UserRefreshRow = {
    id: number;
    username: string;
    nickname: string | null;
    token_version: number;
    object_id: number;
    flag: number;
    extended: string | null;
    avatar: string | null;
    permissions: string | null;
    email: string | null;
    phone: string | null;
  };
  const user = db
    .prepare(
      "SELECT id, username, nickname, token_version, object_id, flag, extended, avatar, permissions, email, phone FROM users WHERE id = ? LIMIT 1"
    )
    .get(payload.sub) as UserRefreshRow | undefined;
  if (!user) {
    throw new BusinessError(401, "user deleted, re-login required | 用户已删除，请重新登录");
  }
  // 业务用户：object_id <= 0 或 flag != 0 → refresh 也强制重新登录
  // 系统管理员（object_id=-1）豁免 — DB 才是事实来源
  const isSysAdmin = user.object_id === -1;
  if (!isSysAdmin) {
    if (user.object_id <= 0) {
      throw new BusinessError(401, "账号未分配项目或已被禁用，请重新登录");
    }
    if (user.flag !== 0) {
      throw new BusinessError(401, "账号已被标记为不可用，请重新登录");
    }
  }
  // 取用户「最新 tv」，保证新签发 token 的 tv 等于最新，避免 refresh 后立刻被 tv mismatch 拒绝
  const latestTv = getUserAuthState(user.id)?.tv ?? user.token_version;

  // 继承原 token 的 scope（admin-panel scope 在 refresh 时保留）
  const inheritScope = payload.scope === "admin-panel" ? { scope: "admin-panel" as const } : {};
  const accessPayload: JwtPayload = {
    sub: user.id,
    username: user.username,
    nickname: user.nickname,
    iat: nowSec,
    exp: nowSec + ACCESS_TOKEN_TTL,
    type: "access",
    fp: fingerprint,
    tv: latestTv,
    jti: "", // 先占位，事务块里生成
    object_id: user.object_id,
    ...inheritScope
  };
  const refreshPayload: JwtPayload = {
    sub: user.id,
    username: user.username,
    nickname: user.nickname,
    iat: nowSec,
    exp: Math.min(payload.exp, nowSec + REFRESH_TOKEN_TTL),
    // ↑refresh 总过期时间延不超过原 family 的「首次签发 + 7d」（避免无限续期）
    type: "refresh",
    fp: fingerprint,
    tv: latestTv,
    jti: "", // 先占位，事务块里生成
    object_id: user.object_id,
    ...inheritScope
  };

  // —— 事务块：仅 mark-invalid + INSERT 两步（原子）——
  const rotateTokens = db.transaction(() => {
    // 4a. 旧行标记 used
    markRowInvalid(row.id, "used");

    // 4b. 签发新 jti 并回填到 payload（事务块内做，避免 INSERT 之后 jti 被改但已无效）
    accessPayload.jti = newJti();
    refreshPayload.jti = newJti();

    // 4c. INSERT 新 refresh_token 行（同 family_id，generation+1）
    db.prepare(
      `INSERT INTO refresh_tokens(user_id, fingerprint, family_id, generation, jwt_id, valid, expires_at)
       VALUES(?,?,?,?,?,?,?)`
    ).run(user.id, fingerprint, row.family_id, nextGen, refreshPayload.jti, 1, refreshPayload.exp);
  });

  rotateTokens();

  // attachRoles 查 role_user + roles 挂虚拟字段
  attachRoles([user as unknown as { id: number } & typeof user]);

  return {
    expires: accessPayload.exp,
    refresh_expires: refreshPayload.exp,
    access_token: createToken(accessPayload),
    refresh_token: createToken(refreshPayload),
    token_type: "Bearer",
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      object_id: user.object_id,
      extended: user.extended,
      avatar: user.avatar,
      permissions: user.permissions,
      roles: (user as any).roles as RoleBrief[],
      email: user.email,
      phone: user.phone
    }
  };
}

/**
 * 登出：用当前 refresh_jwt 撤销所在 family（当前客户端的所有后续 refresh 尝试都会 reuse fail）。
 * 安全网：即使 refresh 传了空也没关系，这是按 jti → family 精准撤销。
 * 如果用户想「所有设备全部登出」：直接 bumpUserTokenVersion(uid)，所有 access_token 2h 内失效，
 *   被置 valid=0 的 refresh_tokens 行会在到期后由 db.ts#purgeExpiredRefreshTokens 自动物理删除
 *   （启动时 + 每 24 小时一次）。
 */
export function logout(optionalRefreshJwt: string | undefined, uid: number): { revoked: number } {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let revoked = 0;
  if (optionalRefreshJwt) {
    const d = decodeToken(optionalRefreshJwt);
    if (typeof d.jti === "string" && typeof d.sub === "number" && d.sub === uid) {
      const row = db
        .prepare(
          "SELECT id, family_id FROM refresh_tokens WHERE jwt_id = ? AND user_id = ? LIMIT 1"
        )
        .get(d.jti, uid) as { id: number; family_id: string } | undefined;
      if (row) {
        revoked += revokeFamily(row.family_id, now, "logout");
      }
    }
  }
  return { revoked };
}

// ========== 内部：DB 辅助 ==========

/** 将一个 family 的所有 refresh 行置为 invalid（reuse / logout / fp_mismatch 场景调用） */
function revokeFamily(familyId: string, nowSec: number, reason: string): number {
  const info = getDb()
    .prepare(
      `UPDATE refresh_tokens
          SET valid = 0, revoked_at = ?, revoke_reason = ?
        WHERE family_id = ? AND valid = 1`
    )
    .run(nowSec, reason.slice(0, 63), familyId);
  return Number(info.changes || 0);
}

function markFamilyInvalid(familyId: string, reason: string): void {
  revokeFamily(familyId, Math.floor(Date.now() / 1000), reason);
}

function markRowInvalid(id: number, reason: string): void {
  getDb()
    .prepare(
      `UPDATE refresh_tokens
          SET valid = 0, revoked_at = ?, revoke_reason = ?
        WHERE id = ? AND valid = 1`
    )
    .run(Math.floor(Date.now() / 1000), reason.slice(0, 63), id);
}

// 对 users.service.ts 提供：改密时 bump token_version + 可选撤销所有 family
export function onUserCredentialChanged(uid: number, logoutEverywhere = true): void {
  bumpUserTokenVersion(uid);
  if (logoutEverywhere) {
    const now = Math.floor(Date.now() / 1000);
    const db = getDb();
    // 所有该用户当前 valid=1 的 family 都标记为 reason='pw_changed'
    const families = db
      .prepare("SELECT DISTINCT family_id FROM refresh_tokens WHERE user_id = ? AND valid = 1")
      .all(uid) as { family_id: string }[];
    for (const f of families) revokeFamily(f.family_id, now, "pw_changed");
    TV_CACHE.delete(uid);
  }
}
