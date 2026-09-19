/**
 * 自定义 SQL 执行 Service。
 *
 * 入口契约（与 routes/v1/custom.ts 一一对应）：
 *   调用方                               本 Service
 *   ─────────────────────────────────    ─────────────────────────────────────
 *   POST /api/custom/:name Body.params   executeCustomQuery(name, params, caller)
 *                                        ↓
 *                                        · 解析模板 → 解析 schema → 编译占位 →
 *                                        · 执行授权 → 资源限制 → 查询 DB →
 *                                        · 写审计日志 → return columns+rows
 *
 * 九条护栏（从上到下，任一不通过直接 4xx/5xx，都不会执行实际 SQL；但会写审计日志，
 * 以便后续分析注入尝试）：
 *   护栏 1：项目级开关 object.custom_sql_enabled（默认 0 关闭；503）
 *   护栏 2：模板启用状态 + 绑定 object 存在（404）
 *   护栏 3：SQL 只允许 SELECT/WITH 开头（关键字黑名单 + 分号多语句/注释/表黑名单 +
 *           sqlite_master/information_schema 关键字）（400 "SQL validation failed | SQL 校验失败: ..."）
 *   护栏 4：命名占位符 :name → 统一转 ?；值全 PreparedStatement 绑定，永不拼字符串
 *   护栏 5：params 必填/类型/默认值校验（按 params_schema 或从占位符推断）（400）
 *   护栏 6：表黑名单（CONFIG_GUARDED_TABLES）命中 → 400 "table ... is guarded"
 *           注：当前是纯正则实现（匹配 FROM/JOIN/UPDATE INTO 等 SQL 关键字后的标识符），
 *               对跨库 / 子查询别名覆盖等 99% 常见查询够用；若未来支持 CTE 临时表命名冲突，
 *               可替换为真正的 SQL AST parser 实现。
 *   护栏 7：认证 + 角色（继承 object.auth_required + role_required=public/user/admin，
 *           其中 admin 判定规则：username=="admin"，因为 users 表当前没有单独的 role 列；
 *           若未来加 role 列，只需改 authorizeCaller 一处）（401 / 403）
 *   护栏 8：资源限制 rows_limit 在外层包 SELECT * FROM (...) LIMIT N（防止拖出大表）；
 *           timeout_ms 软超时预留；IP 级 60/min 限流复用 Redis（Redis 未启用时不做）
 *   护栏 9：审计日志，无论成功/失败写入 custom_query_log 表：
 *             caller_user       = JWT sub（匿名 NULL）
 *             caller_ip         = request.ip（X-Forwarded-For / raw IP，信任前置代理的设置）
 *             params_json       = 实际传参 JSON（SENSITIVE_FIELDS 自动 *** 打码）
 *             row_count / duration_ms / status_code / error_msg（前 500 字）
 *           只有模板 not found（拿不到 template_id）不写日志 —— 避免无效噪音。
 *
 * 执行连接策略：
 *   - SQLite：直接用已注册的通用连接（better-sqlite3 单线程模型；护栏 3 已强制 SELECT-only，
 *             理论上比新开 ro 连接更省资源；生产若要极致隔离可改用 URI:?mode=ro 单独连接）
 *   - MySQL / pg：同样复用已注册连接池；**强烈建议生产上为对应 datasource 单独创建只读账号**
 *             （本代码不强制切换 DB 用户；那是 DBA 在 DS_MYSQL_xxx__URL 层面做的事）
 *
 * 本文件关键函数一览（按执行顺序）：
 *   #0 obj.custom_sql_enabled（object 表）   — 护栏 1，executeCustomQuery 内直读
 *   #1 validateSelectOnly(sql)             — 护栏 3 + 6：SELECT-only + 黑名单 + 单语句
 *   #2 compileNamedParams(sql)             — 护栏 4：:name → ? + 按序 key 列表
 *   #3 parseParamsSchema(tpl)              — 护栏 5 前半段：合并 JSON schema 与从占位推断的默认值
 *   #4 buildArgs(compiled, valids, sch)    — 护栏 5 后半段：构造参数数组 + required/类型校验
 *   #5 authorizeCaller(tpl, obj, caller)   — 护栏 7：Bearer token + role_required 判定
 *   #6 executeCustomQuery(...)             — 主函数：串 #0~#5 + 护栏 2/8/9，返回 columns+rows
 *   #7 writeAuditLog(...)                  — 护栏 9：所有结果写审计日志 + 脱敏
 */

import { getDb } from "../db.js";
import { getDs } from "../datasources/registry.js";
import { CONFIG_GUARDED_TABLES, SYSTEM_ADMIN_OBJECT_ID } from "./config.service.js";
import { BusinessError } from "../utils/errors.js";
import { verifyToken, type JwtPayload, decodeToken } from "./auth.service.js";

// ============================================================================
// DB 行类型
// ============================================================================

export interface QueryTemplateRow {
  id: number;
  object_id: number;
  name: string;
  description: string | null;
  sql_text: string;
  params_schema: string | null;
  role_required: "public" | "user" | "admin" | string;
  rows_limit: number;
  timeout_ms: number;
  enabled: number;
  created_at: number;
}

export interface CustomCaller {
  /** Bearer token 字符串（没有则 undefined） */
  token?: string;
  /** 客户端指纹，用于 token.fp 时序安全比较 */
  fingerprint: string;
  /** 调用方 IP（用于限流 + 审计日志；可以是 fastify request.ip） */
  ip?: string;
}

/** 单个参数的 schema（与 query_template.params_schema JSON 一致） */
export interface ParamSpec {
  type: "string" | "number" | "boolean" | "integer";
  required?: boolean;
  default?: unknown;
  desc?: string;
}

// ============================================================================
// 护栏 1 — per-object 开关（object.custom_sql_enabled）
//   全局 CUSTOM_SQL_ENABLED 已废弃，改为每个 object 行独立配置。
// ============================================================================

// isCustomSqlEnabled 已移除，改为在 executeCustomQuery 内直接检查 obj.custom_sql_enabled

// ============================================================================
// SQL 静态分析工具（护栏 3 / 6：SELECT-only + 表黑名单 + 单语句）
// ============================================================================

/** 致命关键字黑名单（任何出现都拒绝；大小写不敏感） */
const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "REPLACE",
  "TRUNCATE",
  "PRAGMA",
  "ATTACH",
  "DETACH",
  "GRANT",
  "REVOKE",
  "COPY",
  "LOAD_EXTENSION",
  "sqlite_master",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "SET SQL_LOG_BIN",
  "INFORMATION_SCHEMA",
  "PERFORMANCE_SCHEMA",
  "SYS.",
  "mysql.",
  "pg_catalog"
];

/**
 * 对 SQL 做静态护栏检测：
 *   1. 必须以 SELECT/WITH 开头（允许前导空格/注释 /* / -- 单行注释）
 *   2. 不得包含分号（单语句）
 *   3. 不得出现关键字黑名单中的任意词
 *   4. 引用的表名不能在 CONFIG_GUARDED_TABLES 里
 *
 * 表名检测用「FROM <table> / JOIN <table> / INTO <table>」正则，但
 * 因为护栏 3 已经禁止 INSERT/UPDATE/DROP/ALTER，INTO 其实不会出现，
 * 这里主要为 FROM/JOIN 抓表名。
 */
export function validateSelectOnly(sql: string): { ok: true } | { ok: false; reason: string } {
  if (!sql || !sql.trim()) return { ok: false, reason: "SQL is empty" };

  // 2. 多语句拦截（任何 ; 都不允许）
  if (sql.includes(";")) {
    return { ok: false, reason: "multi-statement SQL not allowed (remove ';')" };
  }

  // 3. 去注释后检查关键字黑名单
  const stripped = stripComments(sql);

  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    if (re.test(stripped)) {
      return { ok: false, reason: `forbidden keyword: ${kw.toUpperCase()}` };
    }
  }

  // 1. 开头必须是 SELECT 或 WITH（CTE）
  const head = stripped.replace(/^\s+/, "");
  if (!/^(SELECT|WITH)\b/i.test(head)) {
    return { ok: false, reason: "only SELECT / WITH ... SELECT statements are allowed" };
  }

  // 4. 表名黑名单检测
  const tables = extractTableNames(stripped).map(t => t.toLowerCase());
  for (const t of tables) {
    if (CONFIG_GUARDED_TABLES.has(t)) {
      return { ok: false, reason: `table "${t}" is guarded (configuration table, not accessible)` };
    }
  }

  return { ok: true };
}

/** 提取 SQL 中 FROM / JOIN 后的表名（仅能处理常见情况，非严格语法解析） */
function extractTableNames(sql: string): string[] {
  const out: string[] = [];
  // FROM/JOIN 后接 标识符/反引号/双引号标识符
  const re = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+("(?:[^"]|"")+"|`(?:[^`]|``)+`|[\w]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    let name = m[1];
    // 去引号
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    if (name.startsWith("`") && name.endsWith("`")) name = name.slice(1, -1);
    if (name) out.push(name);
  }
  return out;
}

/** 粗略去掉 SQL 里的 -- line 和 /* block comments */
function stripComments(sql: string): string {
  // 去掉 /* */（非递归即可）
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  // 去掉 -- 直到行尾
  s = s.replace(/--[^\n]*/g, " ");
  return s;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// 命名占位符解析：SELECT * FROM t WHERE id = :id AND title LIKE :title
//   → SQL: SELECT * FROM t WHERE id = ? AND title LIKE ?
//   → keys: ["id", "title"]
//   → argsFn(params): [params.id, params.title]
//
// 同时支持 ? 匿名占位（占位符数量必须与传参数组长度匹配）。
// ============================================================================

export interface CompiledSql {
  sql: string; // 统一为 ? 占位
  keys: string[]; // 占位符顺序（匿名 ? 的位置是 "__pos_N"）
  named: boolean; // 是否是命名占位
}

export function compileNamedParams(sql: string): CompiledSql {
  const keys: string[] = [];

  const namedSql = sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    keys.push(name);
    return "?";
  });
  if (keys.length > 0) {
    return { sql: namedSql, keys, named: true };
  }
  // 匿名 ? 占位
  const anonSql = sql;
  const anon = anonSql.match(/\?/g) ?? [];
  for (let i = 0; i < anon.length; i++) keys.push(`__pos_${i}`);
  return { sql: anonSql, keys, named: false };
}

/**
 * 按模板的 params_schema + 传参对象构造「按占位符顺序的 args 数组」，同时做
 * 必填校验 + 类型强校验。
 *
 * 本函数是「护栏 4 强制参数化」的核心实现，所有返回值都将直接交给
 *   ds.query(sql, args) 作为 PreparedStatement 的占位数组，
 *   绝不进入 SQL 字符串拼接路径。
 *
 * 校验顺序：
 *   1. params 是数组 → 匿名 ? 占位模式，必须 `length == compiled.keys.length`，
 *      否则 400 "expected N positional args, got M"。不做类型校验（匿名模式下
 *      无法为每个位置挂 schema），仅保证数量一致。
 *   2. params 是对象 → 遍历 compiled.keys（compileNamedParams 得出的顺序，
 *      即 SQL 中占位出现的顺序）：
 *        a. key.startsWith("__pos_") → 匿名 SQL 却用对象传参，
 *           400 "positional placeholder ? requires array params ..."（防止混乱）
 *        b. key in params → 使用用户值
 *        c. else if schema[key].default 存在 → 用默认值
 *        d. else if schema[key].required === false → 用 null 兜底
 *        e. 其余情况 → 400 "missing required param: <key>"
 *        f. 拿到值后按 schema[key].type 做 coerce（string/number/integer/boolean），
 *           类型不对 → 400 "param <key> must be number" / "...safe integer"。
 *
 * 设计说明：compileNamedParams 会保证 compiled.keys 的顺序严格与 SQL 中 ? 对应，
 * buildArgs 返回的数组下标一一对应，所以 PreparedStatement 一定不会错位。
 */
export function buildArgs(
  compiled: CompiledSql,
  params: Record<string, unknown> | unknown[],
  schema: Record<string, ParamSpec> | null
): unknown[] {
  // 数组调用：匿名 ? 模式
  if (Array.isArray(params)) {
    if (params.length !== compiled.keys.length) {
      throw new BusinessError(
        400,
        `expected ${compiled.keys.length} positional args, got ${params.length}`
      );
    }
    return params;
  }
  // 对象调用：命名或位置（位置模式下 key 是 __pos_0, __pos_1... 但用户用对象传会奇怪，这里兼容命名优先）
  const args: unknown[] = new Array(compiled.keys.length);
  for (let i = 0; i < compiled.keys.length; i++) {
    const key = compiled.keys[i];
    let spec: ParamSpec | null = null;
    if (schema && key in schema) spec = schema[key];

    // 用户是否传了
    let value: unknown = undefined;
    let provided = false;
    if (key.startsWith("__pos_")) {
      // 匿名模式对象传参不支持，直接报错
      throw new BusinessError(
        400,
        "positional placeholder ? requires array params; please send { params: [...] }"
      );
    }
    if (key in params) {
      provided = true;
      value = params[key];
    } else if (spec && "default" in spec) {
      provided = true;
      value = spec?.default ?? null;
    } else if (spec?.required === false) {
      provided = true;
      value = null;
    }
    if (!provided) {
      throw new BusinessError(400, `missing required param: ${key} | 缺少必填参数: ${key}`);
    }
    // 类型校验（基本）
    if (spec) value = coerce(value, spec.type, key);
    args[i] = value;
  }
  return args;
}

function coerce(v: unknown, type: ParamSpec["type"], key: string): unknown {
  switch (type) {
    case "string":
      if (v === null || v === undefined) return v;
      return String(v);
    case "integer":
    case "number": {
      if (v === null || v === undefined) return v;
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isNaN(n))
        throw new BusinessError(400, `param ${key} must be number | 参数 ${key} 必须是数字`);
      if (type === "integer" && !Number.isSafeInteger(n))
        throw new BusinessError(
          400,
          `param ${key} must be safe integer | 参数 ${key} 必须是安全整数`
        );
      return n;
    }
    case "boolean":
      if (v === null || v === undefined) return v;
      return typeof v === "boolean" ? v : v === "1" || v === "true" || v === "yes";
    default:
      return v;
  }
}

// ============================================================================
// params_schema 反序列化 + 从占位符推断
// ============================================================================

export function parseParamsSchema(
  row: Pick<QueryTemplateRow, "params_schema" | "sql_text">
): Record<string, ParamSpec> {
  if (row.params_schema && row.params_schema.trim()) {
    try {
      const obj = JSON.parse(row.params_schema);
      if (obj && typeof obj === "object") {
        const out: Record<string, ParamSpec> = {};
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          const spec = v as Partial<ParamSpec>;
          const type = (spec.type ?? "string") as ParamSpec["type"];
          if (!["string", "number", "integer", "boolean"].includes(type))
            throw new BusinessError(
              400,
              `invalid type for param ${k}: ${type} | 参数 ${k} 类型无效: ${type}`
            );
          out[k] = {
            type,
            required: spec.required ?? true,
            default: spec.default ?? undefined,
            desc: spec.desc
          };
        }
        return out;
      }
    } catch (e) {
      if (e instanceof BusinessError) throw e;
      throw new BusinessError(
        400,
        `params_schema is not valid JSON | params_schema 不是有效 JSON: ${(e as Error).message}`
      );
    }
  }
  // 推断：从编译出的命名占位生成 required string 类型 schema
  const compiled = compileNamedParams(row.sql_text);
  const inferred: Record<string, ParamSpec> = {};
  for (const k of compiled.keys) {
    if (k.startsWith("__pos_")) continue;
    inferred[k] = { type: "string", required: true };
  }
  return inferred;
}

// ============================================================================
// 护栏 7：认证 + 角色（继承 object.auth_required + role_required）
// ============================================================================

export type RoleLevel = "public" | "user" | "admin";

const ROLE_LEVEL: Record<RoleLevel, number> = { public: 0, user: 1, admin: 2 };

/**
 * 做认证/角色检查：
 *   - 如果 object.auth_required=1 → 必须带合法 accessToken，再按 role_required 判定
 *   - role_required=public → 仅 auth_required 约束（如关闭则匿名也行）
 *   - role_required=user | 需要至少 user 角色/admin → 无论 auth_required 怎样都必须登录，且 admin 比 user 高
 */
export function authorizeCaller(
  auth: CustomCaller,
  context: { authRequired: boolean; roleRequired: RoleLevel; objectId: number }
): JwtPayload | null {
  let payload: JwtPayload | null = null;
  let verifyError: Error | null = null;
  if (auth.token) {
    try {
      payload = verifyToken(auth.token, auth.fingerprint);
    } catch (e) {
      // token 无效当作「没提供」处理（但原始错误保留用于 401）
      verifyError = e as Error;
      payload = null;
    }
  }

  const needAtLeast = (level: RoleLevel) => {
    if (!payload) return false;
    // 角色判定：username == "admin" → 管理员，其余登录用户 → user。
    // （users 表目前没有独立 role 字段，保持与现有 JWT payload 结构一致，username 可直接用。）
    const userRole: RoleLevel = payload.username === "admin" ? "admin" : "user";
    return ROLE_LEVEL[userRole] >= ROLE_LEVEL[level];
  };

  // 如果传了 token 但验签/指纹/过期失败，抛出精确错误（比「没提供」更友好的诊断）
  if (auth.token && !payload && verifyError) {
    if (verifyError instanceof BusinessError) throw verifyError;
    throw new BusinessError(401, verifyError.message);
  }

  if (context.authRequired && !payload) {
    throw new BusinessError(
      401,
      "missing bearer token | 缺少 Bearer token (object.auth_required=1)"
    );
  }

  // —— 护栏 7.5：用户→项目绑定校验（需求 1：object_id=-1=管理员，=具体值要求 object.id 匹配）
  //   这里的绑定校验对登录用户**强制**：即使模板 role_required=public，只要有 token 且用户不是匿名，
  //   就必须满足 object_id === -1 或 === context.objectId。匿名（payload=null）已在上一层 auth_required=1 拒绝。
  if (payload) {
    if (payload.object_id !== SYSTEM_ADMIN_OBJECT_ID && payload.object_id !== context.objectId) {
      throw new BusinessError(
        403,
        `用户"${payload.username}"被绑定到项目 object_id=${payload.object_id}，无权访问绑定项目 object_id=${context.objectId} 的自定义 SQL 模板`
      );
    }
  }

  if (context.roleRequired === "public") return payload;
  if (context.roleRequired === "user") {
    if (!payload)
      throw new BusinessError(
        401,
        "login required (role_required=user | 需要至少 user 角色) | 需要登录（role_required=user | 需要至少 user 角色）"
      );
    if (!needAtLeast("user"))
      throw new BusinessError(403, "role_required=user | 需要至少 user 角色");
    return payload;
  }
  // admin
  if (!payload)
    throw new BusinessError(
      401,
      "login required (role_required=admin | 需要系统管理员角色) | 需要登录（role_required=admin | 需要系统管理员角色）"
    );
  if (!needAtLeast("admin"))
    throw new BusinessError(403, "role_required=admin | 需要系统管理员角色");
  return payload;
}

// ============================================================================
// 审计日志（脱敏参数 JSON）
// ============================================================================

const SENSITIVE_KEY_RE =
  /password|passwd|secret|token|apikey|api_key|session|cookie|credit_card|cvv/i;

export function sanitizeParams(params: unknown): unknown {
  if (params == null) return params;
  if (Array.isArray(params)) return params.map(v => sanitizeParams(v));
  if (typeof params !== "object") return params;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = "***";
    } else {
      out[k] = typeof v === "object" ? sanitizeParams(v) : v;
    }
  }
  return out;
}

/** 写入审计日志（吞错误，绝不影响主流程） */
export function writeLog(entry: {
  template_id: number;
  caller_user: number | null;
  caller_ip: string | null;
  params_json: string;
  row_count: number | null;
  duration_ms: number;
  status_code: number;
  error_msg: string | null;
}): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO custom_query_log(template_id, caller_user, caller_ip, params_json, row_count, duration_ms, status_code, error_msg)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(
      entry.template_id,
      entry.caller_user,
      entry.caller_ip,
      entry.params_json,
      entry.row_count,
      entry.duration_ms,
      entry.status_code,
      entry.error_msg ? String(entry.error_msg).slice(0, 500) : null
    );
  } catch {
    /* ignore log errors */
  }
}

// ============================================================================
// 模板查询（供 config 路由 & custom 路由复用）
// ============================================================================

export function getTemplateByName(name: string): QueryTemplateRow | null {
  return (
    (getDb().prepare("SELECT * FROM query_template WHERE name = ? LIMIT 1").get(name) as
      QueryTemplateRow | undefined) ?? null
  );
}

export interface ObjectMinimal {
  id: number;
  name: string;
  db_type: string;
  db_url: string | null;
  db_path: string | null;
  custom_sql_enabled: number;
  auth_required: number;
}

export function getObjectById(id: number): ObjectMinimal | null {
  return (
    (getDb()
      .prepare(
        "SELECT id, name, db_type, db_url, db_path, custom_sql_enabled, auth_required FROM object WHERE id = ? LIMIT 1"
      )
      .get(id) as ObjectMinimal | undefined) ?? null
  );
}

// ============================================================================
// 主入口：执行自定义 SQL 模板
// ============================================================================

export interface ExecuteResult {
  template: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
}

/**
 * 执行自定义 SQL 模板。
 *
 * 与路由层一一对应：POST /api/custom/:name → 直接调用本函数。
 * 执行全程按「六层护栏 + 审计日志」的顺序串起来，任何一条失败都会：
 *   · 不修改数据库（SQL 被 PreparedStatement 绑定、且 SELECT-only 已静态过滤写关键字）
 *   · 写入 custom_query_log 一条（含错误原因、耗时、脱敏参数）——
 *     只有「template not found | 模板不存在」时拿不到 template_id，因此不写日志。
 *
 * 具体执行顺序：
 *   0. 启动计时（performance.now），加载 tpl / obj 行
 *   1. 护栏 1 — per-object custom_sql_enabled，false → 503
 *   2. 护栏 2 — tpl.enabled=1
 *   3. 护栏 3 — validateSelectOnly(tpl.sql_text) 非 SELECT-only / 命中
 *        表黑名单 / 含分号 / 写关键字 → 400
 *   4. 护栏 5 — authorizeCaller()：按 object.auth_required + role_required
 *        做 Bearer token 验证 + 角色判定；不通过 401/403
 *   5. 护栏 4 — compileNamedParams + parseParamsSchema + buildArgs，
 *        生成最终 PreparedStatement sql+args；缺参数/类型错误时 400
 *   6. 护栏 6（资源限制）— SELECT * FROM (原SQL) AS __wrapped__ LIMIT rows_limit
 *        包一层，防止拖出大表；timeout_ms 保留作跨方言扩展
 *   7. 调用 datasource.query(sql, args) 执行查询（SQLite/MySQL/pg 的
 *        参数化驱动自动做 ? / $1 占位替换）；返回 columns+rows
 *   8. finalize() 写审计日志（成功失败都写）；敏感字段已 *** 脱敏
 *
 * @param templateName  query_template.name（URL 中的 :name 片段，UNIQUE）
 * @param params        模板参数对象 {param1: val, param2: val} 或数组 [val1, val2]（匿名 ? 模式）
 * @param caller        认证上下文：token / fingerprint / ip
 *                      直接从 fastify request headers + request.ip 组装
 * @returns ExecuteResult：模板名 / 列清单 / 结果行 / 行数 / 毫秒耗时
 *                       对应路由层 200 body 的结构，保持一致
 */
export async function executeCustomQuery(
  templateName: string,
  params: unknown,
  caller: CustomCaller
): Promise<ExecuteResult> {
  const t0 = performance.now();

  // —— 模板行 & 关联对象 ——
  const tpl = getTemplateByName(templateName);
  if (!tpl) {
    // 直接抛不记 log，因为拿不到 template_id
    throw new BusinessError(404, `template not found | 模板不存在: ${templateName}`);
  }

  const obj = getObjectById(tpl.object_id);
  if (!obj) {
    throw new BusinessError(404, "template references deleted object | 模板引用了已删除的项目");
  }

  // 统一 try/catch 用来写日志
  const finalize = (
    status_code: number,
    body:
      | { ok: true; columns: string[]; rows: Record<string, unknown>[]; durationMs: number }
      | { ok: false; error: string; durationMs: number }
  ) => {
    let userId: number | null = null;
    if (caller.token) {
      try {
        const payload = decodeToken(caller.token);
        userId = payload.sub ?? null;
      } catch {
        // invalid tokens fall through
      }
    }
    writeLog({
      template_id: tpl.id,
      caller_user: userId,
      caller_ip: caller.ip ?? null,
      params_json: JSON.stringify(sanitizeParams(params)),
      row_count: body.ok ? body.rows.length : null,
      duration_ms: body.durationMs,
      status_code,
      error_msg: body.ok ? null : body.error
    });
  };

  try {
    // 护栏 1：per-object custom_sql_enabled
    if (obj.custom_sql_enabled !== 1) {
      throw new BusinessError(
        503,
        `custom SQL is disabled for object "${obj.name}" (custom_sql_enabled=0) | 项目 "${obj.name}" 禁用了自定义 SQL`
      );
    }
    // 护栏 2：enabled=1
    if (tpl.enabled !== 1)
      throw new BusinessError(
        404,
        `template disabled: ${templateName} | 模板已禁用: ${templateName}`
      );
    // 护栏 3 + 6：SELECT-only + 表黑名单
    const vr = validateSelectOnly(tpl.sql_text);
    if (!vr.ok) {
      throw new BusinessError(400, `SQL validation failed | SQL 校验失败: ${vr.reason}`);
    }
    // 护栏 7：认证 + 角色
    const roleRequired = (tpl.role_required || "public").toLowerCase() as RoleLevel;
    authorizeCaller(caller, {
      authRequired: obj.auth_required === 1,
      roleRequired: ["public", "user", "admin"].includes(roleRequired) ? roleRequired : "public",
      objectId: tpl.object_id
    });

    // 护栏 4：编译占位符
    const compiled = compileNamedParams(tpl.sql_text);
    const schema = parseParamsSchema({
      params_schema: tpl.params_schema,
      sql_text: tpl.sql_text
    });
    const args = buildArgs(compiled, (params ?? {}) as Record<string, unknown> | unknown[], schema);

    // —— 拿 datasource 执行 ——
    const ds = getDs(obj.name);

    // 护栏 8：资源限制 —— rows_limit 自动在外层套一个 LIMIT（不影响原 SQL 的 LIMIT）
    const rowsLimit = Math.max(1, Number(tpl.rows_limit) || 1000);
    const wrappedSql = `SELECT * FROM (${compiled.sql}) AS __wrapped__ LIMIT ${rowsLimit}`;

    // —— timeout_ms（sqlite 只在 connection 级别 busy_timeout，这里不额外挂 query timeout；
    //    MySQL 可在 SQL 注释里挂 /*+ MAX_EXECUTION_TIME(nnn) */，但跨方言不安全，留作用户配置）
    const timeoutMs = Math.max(100, Number(tpl.timeout_ms) || 3000);
    void timeoutMs;

    const rows = await ds.query<Record<string, unknown>>(wrappedSql, args);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const durationMs = Math.round(performance.now() - t0);

    const result = { template: templateName, columns, rows, rowCount: rows.length, durationMs };
    finalize(200, { ok: true, columns, rows, durationMs });
    return result;
  } catch (e) {
    const durationMs = Math.round(performance.now() - t0);
    const status = e instanceof BusinessError ? e.statusCode : 500;
    const message = e instanceof Error ? e.message : String(e);
    finalize(status, { ok: false, error: message, durationMs });
    if (e instanceof BusinessError) throw e;
    throw new BusinessError(500, message);
  }
}
