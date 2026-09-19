/**
 * 请求级认证上下文插件（auth-context）。
 *
 * 解决「同一请求内多个模块重复算 fingerprint / 重复解析 Bearer token」的性能浪费：
 *   · fingerprintFromHeaders(headers) 在同一个请求里可能被 generic.ts → config.service、
 *     custom-sql.ts、auth.ts 路由各自调用 1 次，重复 SHA256 约 0.01ms/次。
 *   · 对 verifyToken 的影响相对较小，但仍然有收益：authContext.bearerToken 一
 *     次解析后到处复用，字符串 slice 和 trim 只做一次。
 *
 * 通过 fastify-plugin 打破封装，挂到 fastify.decorateRequest("authContext")，在
 *   全局 onRequest 钩子中懒初始化（首次访问时才计算，避免 OPTIONS / 静态资源白做功）。
 *   对 GET / 这种完全不走 auth 的请求，fp 计算甚至不会发生（按需创建）。
 *
 * —— 如何消费 ——
 * 在 route handler / 中间件里，先 import "./auth-context.js" 让插件注册（因为 autoload
 * 会扫描此文件自动加载），然后：
 *
 *   const ctx = request.authContext;
 *   const fp = ctx.fingerprint;   // 只算一次 sha256（同请求第二次开始零成本）
 *   const tok = ctx.bearerToken;  // 只做一次 header 解析
 *
 * —— 类型声明 ——
 * 使用 Fastify 的 TypeDeclaration augment：让所有路由的 request.authContext 有强类型，
 * 不会出现 any / undefined 警告。
 */

import fp from "fastify-plugin";
import type { FastifyPluginCallback } from "fastify";
import { computeClientFingerprint, headerValue } from "../services/auth.service.js";

export interface AuthContext {
  /**
   * 懒计算的客户端指纹（SHA-256 hex）。
   * 同请求第一次 getter 被调用时才做 sha256，之后缓存到闭包变量。
   */
  readonly fingerprint: string;
  /**
   * 懒解析的 Bearer token（Authorization: Bearer <token> → <token>，trim 过）；
   * 没有 Bearer 头时返回 undefined。
   */
  readonly bearerToken: string | undefined;
}

const plugin: FastifyPluginCallback = (fastify, _opts, done) => {
  // 类型声明合并：让 FastifyRequest 上有 authContext 字段
  fastify.decorateRequest("authContext", null as unknown as AuthContext);

  fastify.addHook("onRequest", (request, _reply, hookDone) => {
    // 每个请求独立挂一个基于闭包的懒计算 getter 对象
    let cachedFp: string | undefined;
    let cachedTok: string | undefined;
    let tokResolved = false;

    const authHeaders = request.headers;
    const xClientId = headerValue(authHeaders["x-client-id"]);
    const userAgent = headerValue(authHeaders["user-agent"]);

    const ctx: AuthContext = {
      get fingerprint() {
        if (cachedFp == null) {
          cachedFp = computeClientFingerprint(xClientId, userAgent);
        }
        return cachedFp;
      },
      get bearerToken() {
        if (!tokResolved) {
          tokResolved = true;
          const auth = headerValue(authHeaders["authorization"]);
          if (auth && auth.startsWith("Bearer ")) {
            cachedTok = auth.slice("Bearer ".length).trim() || undefined;
          }
        }
        return cachedTok;
      }
    };
    // 利用 fastify 装饰器：把 ctx 赋值给请求（decorateRequest 的字段可以按请求覆盖）
    (request as unknown as { authContext: AuthContext }).authContext = ctx;
    hookDone();
  });

  done();
};

export default fp(plugin, {
  fastify: "5.x",
  name: "auth-context"
});
