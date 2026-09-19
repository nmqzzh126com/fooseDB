/**
 * Fastify 类型声明合并（TypeScript Declaration Merging）。
 *
 * 为什么需要这个文件：
 *   plugins/auth-context.ts 在运行时通过 fastify.decorateRequest("authContext", ...)
 *   给每个请求挂了认证上下文对象，但 decorateRequest 只在运行时动态生效，
 *   TypeScript 不会自动把 .authContext 属性加到 FastifyRequest 类型上，导致
 *   request.authContext 在 IDE 里标红 TS(2339)，即使运行没问题。
 *
 *   这里用标准的「declare module "fastify" { interface FastifyRequest { ... } }」
 *   合并声明，让所有路由 handler 都能拿到强类型的 .authContext。
 *
 *   同样的模式用于未来其他全局装饰器（例如 request.user、request.cache 等）。
 *
 *   TypeScript 会通过文件顶部的 "import type" 激活本声明文件是「模块级别
 *   augment」，而不是全局 ambient（否则 declare module 会变 no-op）。
 */

import type { AuthContext } from "../plugins/auth-context.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * 请求级认证上下文（懒计算）。
     *
     * 由 plugins/auth-context.ts 的 onRequest 钩子在每个请求入口注入，
     * 第一次 getter 被访问时才计算 SHA-256 指纹 / 解析 Bearer 头，
     * 同请求内多处读取零成本（消除 generic/custom/auth 服务重复 SHA）。
     */
    readonly authContext: AuthContext;
  }
}

// —— 类型级自检：确保声明合并真的挂载到 FastifyRequest 上（编译期即可发现漏配）。
// 如果将来 tsconfig include 没包含 *.d.ts，或者 augment 写错了，这行会编译失败。
import type { FastifyRequest as _RawFastifyRequest } from "fastify";
type _AssertAuthContextExtends = _RawFastifyRequest extends {
  authContext: AuthContext;
}
  ? true
  : false;
// 如果此处爆红 → 类型合并没生效，检查：1) d.ts 被 tsconfig.include 包含；2) 文件
// 顶部有 import/export (使本文件成为 module augment，而非 ambient global)。
const _assertAugmentOk: _AssertAuthContextExtends = true;
