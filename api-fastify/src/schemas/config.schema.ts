/**
 * 元数据配置 Schema —— object（项目）与 object_table（表级限制）的请求体校验。
 */

/** 标识符：字母/下划线开头，仅含字母/数字/下划线（对象名 = URL 段） */
const IDENTIFIER = "^[a-zA-Z_][a-zA-Z0-9_]{0,63}$";

const FLAG = { type: "integer", minimum: 0, maximum: 1 } as const;

const DB_TYPE_ENUM = ["sqlite", "mysql", "postgres"];

/** POST /api/config/objects */
export const CreateObjectSchema = {
  type: "object",
  required: ["name", "db_type"],
  additionalProperties: false,
  properties: {
    name: { type: "string", pattern: IDENTIFIER },
    description: { type: "string", maxLength: 500 },
    db_type: { type: "string", enum: DB_TYPE_ENUM },
    db_url: { type: "string", maxLength: 1000 },
    db_path: { type: "string", maxLength: 1000 },
    cors_origins: { type: "string", maxLength: 2000 },
    cors_methods: { type: "string", maxLength: 500 },
    custom_sql_enabled: FLAG,
    auth_required: FLAG,
    enabled: FLAG
  }
} as const;

/** PUT /api/config/objects/:id（全部可选） */
export const UpdateObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 500 },
    db_type: { type: "string", enum: DB_TYPE_ENUM },
    db_url: { type: ["string", "null"], maxLength: 1000 },
    db_path: { type: ["string", "null"], maxLength: 1000 },
    cors_origins: { type: ["string", "null"], maxLength: 2000 },
    cors_methods: { type: ["string", "null"], maxLength: 500 },
    custom_sql_enabled: FLAG,
    auth_required: FLAG,
    enabled: FLAG
  }
} as const;

/** POST /api/config/objects/:id/tables */
export const CreateTableRuleSchema = {
  type: "object",
  required: ["object_id", "table_name"],
  additionalProperties: false,
  properties: {
    object_id: { type: "integer", minimum: 1 },
    table_name: { type: "string", pattern: IDENTIFIER },
    blocked: FLAG,
    allow_select: FLAG,
    allow_insert: FLAG,
    allow_update: FLAG,
    allow_delete: FLAG,
    allow_batch_insert: FLAG,
    allow_batch_update: FLAG,
    allow_batch_delete: FLAG
  }
} as const;

/** PUT /api/config/objects/:id/tables/:ruleId（全部可选） */
export const UpdateTableRuleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    blocked: FLAG,
    allow_select: FLAG,
    allow_insert: FLAG,
    allow_update: FLAG,
    allow_delete: FLAG,
    allow_batch_insert: FLAG,
    allow_batch_update: FLAG,
    allow_batch_delete: FLAG
  }
} as const;
