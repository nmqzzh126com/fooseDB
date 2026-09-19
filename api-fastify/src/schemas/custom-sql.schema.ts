/**
 * query_template 配置校验 schema —— Fastify { schema: { body: ... } } 路由层强校验。
 *
 * 作用场景：
 *   · POST   /api/config/query-templates      → CreateQueryTemplateSchema（必填三字段）
 *   · PUT    /api/config/query-templates/:id  → UpdateQueryTemplateSchema（全可选）
 *
 * 本层（"第一层防线"）只校验「数据形状 / 取值范围 / 字段列表」，保证请求体符合
 * app.db 写入约束。更深一层的业务校验（SELECT-only 静态分析 / params_schema
 * JSON 合法性 / object 存在性）在 query-template.service.ts 的
 * createTemplate / updateTemplate 中进行 —— 因为需要查 DB / 跑自定义逻辑，
 * 无法在 JSON Schema 层表达。
 *
 * 字段说明（与 routes/config/query-templates.ts 顶部「字段总览」保持一致）：
 *
 *   object_id        integer  >=1                   必填；关联的 object.id（由 app.db object 表 FK 保证合法时不会被删，否则 404）
 *   name             string   ^IDENTIFIER$ <=64     必填；全局 UNIQUE；即 URL POST /api/custom/<name> 这段
 *   description      string   <=500                 可选；模板中文说明，仅阅读用，运行时忽略
 *   sql_text         string   非空 <=1M             必填；SQL 模板本体。必须 SELECT-only，且占位：
 *                                                     命名占位 :name  （推荐，对应 Body.params 对象）
 *                                                     匿名占位 ?     （对应 Body.params 数组，
 *                                                                       executeCustomQuery 支持但 schema 此处不做区分）
 *                                                     建议统一写命名占位，便于 params_schema 按名字对应。
 *
 *   params_schema    string | null                 可选；SQLite 以 TEXT 存 JSON，格式必须是：
 *                                                     {
 *                                                       "<paramName>": {
 *                                                         "type": "string" | "number" | "integer" | "boolean",
 *                                                         "required": true | false,     // default true
 *                                                         "default": <any>,             // required=false 时生效
 *                                                         "desc": "<string>"            // 文档字段，运行时忽略
 *                                                       }, ...
 *                                                     }
 *                                                   传 null / 空串 / 未传 → parseParamsSchema 自动从 SQL 的 :name
 *                                                   占位生成 required=true, type=string 的兜底契约。
 *
 *   role_required    enum(public|user|admin)       可选，默认 public。鉴权层级：
 *                                                     public：允许匿名调用（仍受 object.auth_required=1 覆盖）
 *                                                     user  ：需要登录（任意用户）
 *                                                     admin ：必须 username=="admin"（当前 users 表无独立 role 列，用用户名判定）
 *
 *   rows_limit       integer  1..100000            可选，默认 1000。在外层 SELECT * FROM (...) LIMIT N 包一层，
 *                                                   防止开发忘写 LIMIT 导致拖大表。
 *   timeout_ms       integer  100..60000           可选，默认 3000。SQL 执行软超时（毫秒）。SQLite 方言目前
 *                                                   busy_timeout 已配置，语句级 timeout 作为跨方言扩展预留。
 *   enabled          integer  0/1                  可选，默认 1。=0 时调用端直接 404 template disabled，
 *                                                   管理端本身仍可查看 / 改动，方便灰度/回滚。
 *
 * 其他规则：
 *   additionalProperties: false — 多余字段一律 400，防止拼写错误（如 rowsLimt 这种把错误当空字段写入 DB）。
 *   IDENTIFIER       "^[a-zA-Z_][a-zA-Z0-9_]{0,64}$" —— 只允许标识字符，防止 shell 注入 / URL 冲突。
 */

const IDENTIFIER = "^[a-zA-Z_][a-zA-Z0-9_]{0,64}$";
const FLAG = { type: "integer", minimum: 0, maximum: 1 } as const;
const NONEMPTY_STRING = { type: "string", minLength: 1, maxLength: 1_000_000 } as const;

const ROLE_ENUM = { enum: ["public", "user", "admin"] } as const;

/**
 * POST /api/config/query-templates  —— 创建用 schema。
 * 必选三字段：object_id（绑项目、绑数据源、绑权限）/ name（调用 URL 段）/ sql_text（SQL 模板）。
 * 其余字段有合理默认值：role_required=public / rows_limit=1000 / timeout_ms=3000 / enabled=1。
 */
export const CreateQueryTemplateSchema = {
  type: "object",
  required: ["object_id", "name", "sql_text"],
  additionalProperties: false,
  properties: {
    object_id: { type: "integer", minimum: 1 },
    name: { type: "string", pattern: IDENTIFIER, maxLength: 64 },
    description: { type: "string", maxLength: 500 },
    sql_text: NONEMPTY_STRING,
    // params_schema：JSON 字符串（因为 SQLite 单列存 JSON，用 TEXT 类型）；入库后 parseParamsSchema 再解析
    params_schema: { type: ["string", "null"] },
    role_required: { ...ROLE_ENUM, default: "public" },
    rows_limit: { type: "integer", minimum: 1, maximum: 100_000, default: 1000 },
    timeout_ms: { type: "integer", minimum: 100, maximum: 60_000, default: 3000 },
    enabled: FLAG
  }
} as const;

/**
 * PUT /api/config/query-templates/:id  —— 更新用 schema。
 * 所有字段全可选，partial 更新：
 *   · name 变 → 触发 UNIQUE(name) 409 检查
 *   · sql_text 变 → 触发 validateSelectOnly 重检查（保证写进去的还是 SELECT-only）
 *   · params_schema 变 → 触发 JSON.parse + parseParamsSchema 重检查
 *   · object_id 变 → 校验 object 存在（其数据源在项目创建时已注册）
 * 空 patch（请求体无任何匹配字段）→ service 层短路，不做无意义 UPDATE。
 */
export const UpdateQueryTemplateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", pattern: IDENTIFIER, maxLength: 64 },
    description: { type: "string", maxLength: 500 },
    sql_text: NONEMPTY_STRING,
    params_schema: { type: ["string", "null"] },
    object_id: { type: "integer", minimum: 1 },
    role_required: ROLE_ENUM,
    rows_limit: { type: "integer", minimum: 1, maximum: 100_000 },
    timeout_ms: { type: "integer", minimum: 100, maximum: 60_000 },
    enabled: FLAG
  }
} as const;
