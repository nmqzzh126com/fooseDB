/**
 * /api/auth/* 请求体校验 Schema。
 *
 * 说明：
 *   - refresh_token 字段统一允许 minLength 1，实际是否有效交给 service 层签名校验
 *     （JWT 长度随 payload 变化，写死的 maxLength 没意义）。
 *   - logout 的 refresh_token 是可选的：不传时等同于"放弃此 logout 请求的精准撤销"，
 *     服务端会保守返回 revoked=0，不报错（方便前端无脑 always-body）。
 */

export const LoginBodySchema = {
  type: "object",
  required: ["username", "password"],
  additionalProperties: false,
  properties: {
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 }
  }
} as const;

export const RefreshBodySchema = {
  type: "object",
  required: ["refresh_token"],
  additionalProperties: false,
  properties: {
    refresh_token: { type: "string", minLength: 1 }
  }
} as const;

export const LogoutBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    // 可选；传了就按 jti→family 精准撤销（当前浏览器），不传就是一个温和的「前端忘 cookie」动作。
    refresh_token: { type: "string", minLength: 1 }
  }
} as const;
