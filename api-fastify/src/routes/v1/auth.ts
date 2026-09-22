/**
 * 认证路由：
 *   POST /api/auth/login     — 登录，签发双 token（绑定客户端指纹 + token_version 代次），
 *                               写入 refresh_tokens（family_id+generation=1）
 *   GET  /api/auth/me        — 受保护路由，校验 Bearer token + 客户端指纹（同请求内指纹/解析懒缓存）
 *   POST /api/auth/refresh   — 轮换 refresh_token：type=refresh + 指纹 + jti→refresh_tokens
 *                               存在 & valid=1 → generation+1 换新 access+refresh；
 *                               valid=0（Reuse Detection）→ 整 family 作废 → 401 要求重登
 *   POST /api/auth/logout    — 登出：当前 Bearer 对应的 uid 撤销 jti→family（精准下线当前浏览器）
 *
 * 安全措施：
 *   - P1 登录限流：同一 IP 60 秒内最多 5 次尝试（Redis cache_default 计数器，Stub 放行）
 *   - P2 客户端指纹绑定：X-Client-Id > User-Agent 计算 SHA-256 写入 JWT payload.fp，
 *        verifyToken / refresh 都会时序比对；换浏览器/UA → 旧 refresh 无法续，直接 401 重登
 *   - P3 token_version：users.token_version（改密 +1，verifyToken payload.tv < 最新 → 401）
 *   - P4 refresh 轮换 + Reuse Detection（见 routes 内注释）
 */

import { type FastifyPluginAsync } from "fastify";
import {
  login,
  verifyToken,
  refresh as refreshToken,
  logout as logoutService,
  type LoginResult
} from "../../services/auth.service.js";
import { LoginBodySchema, RefreshBodySchema, LogoutBodySchema } from "../../schemas/auth.schema.js";
import { BusinessError } from "../../utils/errors.js";
import { ratelimitCheck } from "../../plugins/ratelimit.js";
import { getDb } from "../../db.js";
import { getDs } from "../../datasources/registry.js";
import { attachRoles, type RoleBrief } from "../../services/users.service.js";

/** 解析正整数环境变量；缺省/非法（0、负数、小数、非数字）时回退 fallback */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return fallback;
  return n;
}

/**
 * 登录限流（IP 维度），复用 ratelimitCheck 逻辑。
 * 可用 .env 覆盖：LOGIN_RATE_LIMIT（窗口内最大尝试次数，默认 5）、
 *                LOGIN_WINDOW_SEC（窗口时长秒数，默认 60）；未配置或非法时用默认值。
 */
const LOGIN_RATE_LIMIT = parsePositiveInt(process.env.LOGIN_RATE_LIMIT, 5);
const LOGIN_WINDOW_SEC = parsePositiveInt(process.env.LOGIN_WINDOW_SEC, 60);

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  // ==========================================================================
  // POST /api/auth/login：登录 + 签发绑定指纹的双 token
  // ==========================================================================
  fastify.post<{ Body: { username: string; password: string } }>(
    "/api/auth/login",
    { schema: { body: LoginBodySchema } },
    async function (request, reply) {
      // P1 登录限流（Redis Stub 时自动放行）
      const subject = `login:${request.ip}`;
      const r = await ratelimitCheck("cache_default", subject, LOGIN_RATE_LIMIT, LOGIN_WINDOW_SEC);
      reply.header("X-RateLimit-Limit", String(LOGIN_RATE_LIMIT));
      reply.header("X-RateLimit-Remaining", String(r.remaining));
      if (!r.allowed) {
        reply.header("Retry-After", String(r.retryAfterSec));
        return reply.code(429).send({
          error: "TOO_MANY_REQUESTS | 请求过于频繁",
          message: `登录尝试过于频繁，请 ${r.retryAfterSec} 秒后重试。`,
          retryAfterSec: r.retryAfterSec
        });
      }

      try {
        // P2：fingerprint 从请求级 authContext 懒取（同一请求只会算一次 sha256）
        const fp = request.authContext.fingerprint;
        const result: LoginResult = await login(request.body.username, request.body.password, fp);
        return reply.send({ data: result });
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        console.error("[login] UNEXPECTED ERROR:", e);
        return reply.code(500).send({ error: "INTERNAL", message: (e as Error).message, stack: (e as Error).stack });
      }
    }
  );

  // ==========================================================================
  // GET /api/auth/me：验证 Bearer token + 指纹，并返回用户信息（含扩展字段 + roles）
  //   分流逻辑：
  //     - payload.scope === "admin-panel" → 走 app.db 的 users + role_user + roles
  //     - payload.ds 存在（如 "sqlite_demo"）→ 走 getDs(ds) 的 foose_users + foose_role_user + foose_roles
  //   后端 roles 统一返回 RoleBrief[] 对象数组，前端自行转 string[]
  // ==========================================================================
  fastify.get("/api/auth/me", async function (request, reply) {
    try {
      const token = request.authContext.bearerToken;
      if (!token) throw new BusinessError(401, "missing bearer token | 缺少 Bearer token");
      const fp = request.authContext.fingerprint;
      const payload = await verifyToken(token, fp);

      const isAdminPanel = payload.scope === "admin-panel";
      const dsName: string | undefined = (payload as any).ds;

      let extRow:
        | {
            id: number;
            extended: string | null;
            avatar: string | null;
            permissions: string | null;
            email: string | null;
            phone: string | null;
          }
        | undefined;
      let roles: RoleBrief[] = [];

      if (isAdminPanel) {
        // —— admin-panel 路径：查 app.db ——
        try {
          extRow = getDb()
            .prepare(
              "SELECT id, extended, avatar, permissions, email, phone FROM users WHERE id = ? LIMIT 1"
            )
            .get(payload.sub) as any;
        } catch {
          extRow = undefined;
        }
        if (extRow) {
          const [withRoles] = await attachRoles([extRow]);
          roles = withRoles.roles;
        }
      } else if (dsName) {
        // —— 业务用户路径：查 getDs(dsName).foose_users + foose_role_user + foose_roles ——
        const db = getDs(dsName);
        const table = process.env.USER_TABLE ?? "foose_users";
        try {
          const rows = await db.query(
            `SELECT id, extended, avatar, permissions, email, phone FROM "${table}" WHERE id = ? LIMIT 1`,
            [payload.sub]
          );
          extRow = rows[0] as any; // query 返回数组，取第一条
        } catch {
          extRow = undefined;
        }
        if (extRow) {
          const [withRoles] = await attachRoles([extRow as any], {
            dsName,
            userRoleTable: "foose_role_user",
            roleTable: "foose_roles"
          });
          roles = withRoles.roles;
        }
      }

      return {
        data: {
          id: payload.sub,
          username: payload.username,
          nickname: payload.nickname,
          token_type: payload.type,
          token_version: payload.tv,
          object_id: payload.object_id,
          expires: payload.exp,
          extended: extRow?.extended ?? null,
          avatar: extRow?.avatar ?? null,
          permissions: extRow?.permissions ?? null,
          roles,
          email: extRow?.email ?? null,
          phone: extRow?.phone ?? null
        }
      };
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // ==========================================================================
  // POST /api/auth/refresh：refresh_token 轮换
  // ==========================================================================
  fastify.post<{ Body: { refresh_token: string } }>(
    "/api/auth/refresh",
    { schema: { body: RefreshBodySchema } },
    async function (request, reply) {
      try {
        const next = await refreshToken(
          request.body.refresh_token,
          request.authContext.fingerprint
        );
        return { data: next };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // ==========================================================================
  // POST /api/auth/logout：注销当前用户此浏览器 session（精准撤销 jti→family）
  // ==========================================================================
  fastify.post<{ Body: { refresh_token?: string } }>(
    "/api/auth/logout",
    { schema: { body: LogoutBodySchema } },
    async function (request, reply) {
      try {
        const tok = request.authContext.bearerToken;
        // logout 可以无需严格认证；若 Bearer 存在（通常有）就用 payload.sub；否则视为匿名登出，revoked 0
        let uid: number | null = null;
        let errMsg: string | undefined;
        if (tok) {
          try {
            const payload = await verifyToken(tok, request.authContext.fingerprint);
            uid = payload.sub;
          } catch (e) {
            // token 过期/失效时仍允许「前端按 logout 尝试撤销」，不要把前端卡在"token 过期导致没法登出"
            // 这种情况下没有 uid，refresh_token 的撤销靠 jti 匹配（若传了 refresh_token 且其 jti 存在）
            errMsg = e instanceof BusinessError ? e.message : String((e as Error).message);
          }
        }
        let revoked = 0;
        if (uid != null) {
          const r = logoutService(request.body.refresh_token, uid);
          revoked = r.revoked;
        } else if (request.body.refresh_token) {
          // 没 uid 但有 refresh_token：尝试用 decodeToken(jti) 找 family；用户 ID 不会在此分支 match
          //   （因为 decodeToken 取的 sub 没 uid 校验，保守拒绝）
          revoked = 0;
        }
        const body: { ok: boolean; revoked: number; warning?: string } = {
          ok: true,
          revoked
        };
        if (errMsg) body.warning = errMsg;
        return reply.code(200).send(body);
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );
};

export default plugin;
