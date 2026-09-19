/** users 路由的参数校验 Schema（复用旧 users.ts 的 JSON Schema，提取出来单独维护）。 */

export const CreateUserBodySchema = {
  type: "object",
  required: ["username", "password"],
  additionalProperties: false,
  properties: {
    username: { type: "string", minLength: 1 },
    nickname: { type: "string" },
    password: { type: "string", minLength: 1 },
    object_id: { type: "integer" },
    flag: { type: "integer", minimum: 0 },
    email: { type: "string", nullable: true },
    phone: { type: "string", nullable: true },
    avatar: { type: "string", nullable: true },
    permissions: { type: "string", nullable: true },
    extended: { type: "string", nullable: true }
  }
};

export const UpdateUserBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    username: { type: "string", minLength: 1 },
    nickname: { type: "string" },
    password: { type: "string", minLength: 1 },
    object_id: { type: "integer" },
    flag: { type: "integer", minimum: 0 },
    email: { type: "string", nullable: true },
    phone: { type: "string", nullable: true },
    avatar: { type: "string", nullable: true },
    permissions: { type: "string", nullable: true },
    extended: { type: "string", nullable: true }
  }
};

export const UserIdParamSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", pattern: "^\\d+$" }
  }
};
