/**
 * 元数据配置 Service —— object（项目）+ object_table（表级限制）。
 *
 * 配置库固定为 app.db（内置 sqlite_app 数据源），所有读写走同步 better-sqlite3；
 * object / object_table 是整个通用 API 的「目录层」，其他子系统（通用 CRUD、CORS、
 * 自定义 SQL）都依赖这两张表做名称→权限→数据源的解析。
 *
 * 本服务的输出被以下子系统直接消费：
 *   模块                                 消费的函数 / 字段
 *   ────────────────────────────────     ─────────────────────────────────────────
 *   routes/v1/generic.ts                 resolveObjectAccess(name, table, op, auth)
 *                                        一次请求中一次性检查项目存在 / auth / 数据源可用 / 表级限制
 *   plugins/cors.ts                      每条 GET /api/:o/:t 实时读 object 行的 cors_origins/cors_methods
 *   query-template.service.ts            create/update 时，object.id 存在性检查，
 *                                        确保模板写入时关联的项目合法
 *   routes/config/query-templates.ts     间接通过上一条检查 object 外键
 *
 * 职责分项：
 *   1. object CRUD（供 /api/config/objects 使用）
 *        · name 命名规则：identifier + 非保留名（见 RESERVED_OBJECT_NAMES 下注释）
 *        · 每行自带 db_type/db_url/db_path 连接配置；create/update 时动态注册/重注册数据源
 *   2. object_table CRUD（供 /api/config/objects/:id/tables 使用）
 *        · blocked / allow_select/insert/update/delete 六个独立开关；blocked 优先级最高
 *   3. resolveObjectAccess：通用 CRUD 访问控制解析
 *        - 项目是否存在（404）
 *        - auth_required=1 → 调 verifyToken(access_token, fingerprint)（401）
 *        - object 对应的数据源已在 registry 注册（object.name 为 key；404/502）
 *        - 表级限制：blocked=1 整表 403；allow_<op>=0 → 403 带操作名
 *        - 配置库自保护：CONFIG_GUARDED_TABLES（object/object_table/users/
 *          query_template/custom_query_log）→ 403 "配置库表 xxx 不允许通过通用接口访问"
 *
 * 注意：
 *   自定义 SQL 的 SELECT-only / 表黑名单 检查走 custom-sql.ts#validateSelectOnly，
 *   不经过本 resolveObjectAccess，因为 custom-sql 不是按「项目-表」二元组走的。
 */

import { getDb } from "../db.js";
import { BusinessError } from "../utils/errors.js";
import { verifyToken, type JwtPayload } from "./auth.service.js";
import {
  registerObjectDs,
  unregisterObjectDs,
  reregisterObjectDs,
  hasDs,
  getDs
} from "../datasources/registry.js";
import type { TableInfo } from "../datasources/types.js";

export interface ObjectRow {
  id: number;
  name: string;
  description: string | null;
  db_type: string;
  db_url: string | null;
  db_path: string | null;
  cors_origins: string | null;
  cors_methods: string | null;
  custom_sql_enabled: number;
  auth_required: number;
  enabled: number;
  debug: number;
  created_at: number;
}

export interface TableRuleRow {
  id: number;
  object_id: number;
  table_name: string;
  blocked: number;
  allow_select: number;
  allow_insert: number;
  allow_update: number;
  allow_delete: number;
  allow_batch_insert: number;
  allow_batch_update: number;
  allow_batch_delete: number;
  created_at: number;
}

export type Operation = "select" | "insert" | "update" | "delete" | "batch_insert" | "batch_update" | "batch_delete";

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/**
 * 配置表黑名单（双路径校验）：
 *   1. 通用 CRUD：resolveObjectAccess 中，当 object.name === "sqlite_app"（配置库）
 *      且请求表名命中此 Set → 403 "配置库表 xxx 不允许通过通用接口访问"
 *   2. 自定义 SQL：validateSelectOnly 中，FROM/JOIN 后表名命中此 Set → 400 "SQL validation failed | SQL 校验失败"
 *      （哪怕是 SELECT-only，也不能让任意调用方看模板定义、审计日志里的 IP/UID）
 * 各表屏蔽原因：
 *   object             —— 项目清单，泄露意味着攻击者知道所有 datasource 绑定
 *   object_table       —— 表操作限制，泄露意味着攻击者知道哪些接口被禁用可以绕开
 *   users              —— 用户表含 bcrypt 密码哈希，绝不允许通用接口 SELECT（防止离线暴力破解哈希）
 *   query_template     —— 自定义 SQL 模板定义，泄露占位符 schema 为注入提供线索
 *   custom_query_log   —— 审计日志含 caller_ip / params_json 脱敏（即便脱敏，也不应被普通用户看）
 * 注意：只在「app.db（sqlite_app 数据源）」内生效；若某个项目实际也创建了同名表，
 *       只会在 sqlite_app 数据源自保护时被拦截；其他 MySQL 数据源里的 users 等表名不会被拦。
 *       管理端 /api/config/* 接口直接写 app.db，不走此黑名单（由管理端本身的权限/认证控制）。
 */
export const CONFIG_GUARDED_TABLES = new Set([
  "object",
  "object_table",
  "users",
  "query_template",
  "custom_query_log"
]);

/**
 * 项目名保留清单 —— 禁止创建与这些命名相同的 object（name）：
 *   config  —— 与 /api/config/* 管理路由冲突（/api/config/objects、/api/config/query-templates 等）
 *   auth    —— 与 /api/auth/* 登录/鉴权路由冲突（/api/auth/login、/api/auth/me、/api/auth/refresh）
 *   users   —— 与 /api/users 静态路由冲突（原 user CRUD 独立于通用 CRUD 之外）
 *   custom  —— 与 POST /api/custom/:name 自定义 SQL 执行路由冲突（query_template.name 走这段）
 * 不区分大小写比较（"Config" / "CONFIG" 都会被拒绝）。
 * 新增顶级静态 /api/<name>/ 路径时，记得把 name 加入此 Set，否则先注册的通用动态路由 /api/:object/:table
 * 会把它当 object 解析，静态路由 404。
 */
const RESERVED_OBJECT_NAMES = new Set(["config", "auth", "users", "custom"]);

function assertIdentifier(value: string, label: string): void {
  if (!IDENT_RE.test(value)) {
    throw new BusinessError(
      400,
      `${label} "${value}" 含非法字符（仅允许字母/数字/下划线，字母开头）`
    );
  }
}

/**
 * 校验 db_type 合法。
 *
 * 已开放 sqlite / mysql / postgres 三种。
 */
function assertValidDbType(dbType: string): void {
  if (!["sqlite", "mysql", "postgres"].includes(dbType)) {
    throw new BusinessError(400, `db_type "${dbType}" 无效（仅支持 sqlite / mysql / postgres）`);
  }
}

/** 校验连接参数完整性 */
function assertValidConnection(
  dbType: string,
  dbUrl?: string | null,
  dbPath?: string | null
): void {
  if (dbType === "sqlite") {
    if (!dbPath) throw new BusinessError(400, "db_type=sqlite 时必须提供 db_path");
  } else {
    if (!dbUrl) throw new BusinessError(400, `db_type=${dbType} 时必须提供 db_url`);
  }
}

// ============================== object CRUD ==============================

export function listObjects(): ObjectRow[] {
  return getDb().prepare("SELECT * FROM object ORDER BY id").all() as ObjectRow[];
}

export function getObject(id: number): ObjectRow {
  const row = getDb().prepare("SELECT * FROM object WHERE id = ?").get(id) as ObjectRow | undefined;
  if (!row) throw new BusinessError(404, `Object not found | 项目不存在: ${id}`);
  return row;
}

/** 按 name 查 object 配置（认证链路用：从业务数据源反推 JWT.object_id） */
export function getObjectByName(name: string): ObjectRow | null {
  return getDb().prepare("SELECT * FROM object WHERE name = ?").get(name) as ObjectRow | undefined ?? null;
}

export async function createObject(input: {
  name: string;
  description?: string;
  db_type: string;
  db_url?: string | null;
  db_path?: string | null;
  cors_origins?: string | null;
  cors_methods?: string | null;
  custom_sql_enabled?: number;
  auth_required?: number;
  enabled?: number;
  debug?: number;
}): Promise<ObjectRow> {
  assertIdentifier(input.name, "项目名称");
  if (RESERVED_OBJECT_NAMES.has(input.name.toLowerCase())) {
    throw new BusinessError(
      400,
      `项目名称 "${input.name}" 为保留名（与内置路由冲突），请换一个名称`
    );
  }
  assertValidDbType(input.db_type);
  assertValidConnection(input.db_type, input.db_url, input.db_path);
  const auth = input.auth_required ? 1 : 0;
  const cse = input.custom_sql_enabled ? 1 : 0;
  const enabled = input.enabled === undefined ? 1 : input.enabled ? 1 : 0;
  const debug = input.debug ? 1 : 0;
  try {
    const info = getDb()
      .prepare(
        `INSERT INTO object(name, description, db_type, db_url, db_path, cors_origins, cors_methods, custom_sql_enabled, auth_required, enabled, debug)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.name,
        input.description ?? null,
        input.db_type,
        input.db_url ?? null,
        input.db_path ?? null,
        input.cors_origins ?? null,
        input.cors_methods ?? null,
        cse,
        auth,
        enabled,
        debug
      );
    const row = getObject(Number(info.lastInsertRowid));
    // 动态注册数据源
    await registerObjectDs(row);
    return row;
  } catch (e) {
    if (String((e as Error)?.message ?? "").includes("UNIQUE")) {
      throw new BusinessError(409, `项目名称 "${input.name}" 已存在`);
    }
    throw e;
  }
}

export async function updateObject(
  id: number,
  input: {
    description?: string;
    db_type?: string;
    db_url?: string | null;
    db_path?: string | null;
    cors_origins?: string | null;
    cors_methods?: string | null;
    custom_sql_enabled?: number;
    auth_required?: number;
    enabled?: number;
    debug?: number;
  }
): Promise<ObjectRow> {
  const cur = getObject(id);

  // sqlite_app 不允许改连接参数（保护内置 config DB）
  const isBuiltin = cur.name === "sqlite_app";
  const dbType = input.db_type ?? cur.db_type;
  const dbUrl = input.db_url !== undefined ? input.db_url : cur.db_url;
  const dbPath = input.db_path !== undefined ? input.db_path : cur.db_path;

  if (input.db_type) {
    assertValidDbType(input.db_type);
    assertValidConnection(input.db_type, input.db_url, input.db_path);
  }
  if (isBuiltin && (input.db_type || input.db_url !== undefined || input.db_path !== undefined)) {
    throw new BusinessError(400, "内置配置库 sqlite_app 不允许修改数据库连接参数");
  }

  getDb()
    .prepare(
      `UPDATE object SET
        description = COALESCE(?, description),
        db_type = ?,
        db_url = ?,
        db_path = ?,
        cors_origins = ?,
        cors_methods = ?,
        custom_sql_enabled = COALESCE(?, custom_sql_enabled),
        auth_required = COALESCE(?, auth_required),
        enabled = COALESCE(?, enabled),
        debug = COALESCE(?, debug)
      WHERE id = ?`
    )
    .run(
      input.description ?? null,
      dbType,
      dbUrl,
      dbPath,
      input.cors_origins !== undefined ? input.cors_origins : null,
      input.cors_methods !== undefined ? input.cors_methods : null,
      input.custom_sql_enabled === undefined ? null : input.custom_sql_enabled ? 1 : 0,
      input.auth_required === undefined ? null : input.auth_required ? 1 : 0,
      input.enabled === undefined ? null : input.enabled ? 1 : 0,
      input.debug === undefined ? null : input.debug ? 1 : 0,
      id
    );
  const updated = getObject(id);
  // 连接参数实际变更 → 重新注册数据源（只在 db_type/db_url/db_path 真变时才重连，
  // 避免每次保存无关字段（如 enabled/auth_required）时触发重连，若此时 .db 文件还不存在会 500）
  const connChanged =
    updated.db_type !== cur.db_type ||
    (updated.db_url ?? "") !== (cur.db_url ?? "") ||
    (updated.db_path ?? "") !== (cur.db_path ?? "");
  if (connChanged) {
    try {
      await reregisterObjectDs(updated);
    } catch (e) {
      // 数据源打开失败不应让配置保存失败（比如用户路径填错、文件还不存在）
      // 打印 warn，项目记录本身已正确写入
      console.warn(`[config.service] object "${updated.name}" 数据源重注册失败（配置已保存）:`, e);
    }
  }
  return updated;
}

export async function deleteObject(id: number): Promise<void> {
  const cur = getObject(id);
  if (cur.name === "sqlite_app") {
    throw new BusinessError(400, "内置配置库 sqlite_app 不允许删除");
  }
  // object_table 行通过外键 ON DELETE CASCADE 级联删除（foreign_keys=ON 已开启）
  const info = getDb().prepare("DELETE FROM object WHERE id = ?").run(id);
  if (info.changes === 0) throw new BusinessError(404, `Object not found | 项目不存在: ${id}`);
  // 注销数据源
  await unregisterObjectDs(cur.name);
}

// ============================== object_table CRUD ==============================

export interface ListTableRulesOptions {
  /** 页码，从 1 开始，默认 1 */
  page?: number;
  /** 每页条数，默认 50，最大 500 */
  pageSize?: number;
  /** 按表名模糊匹配（LIKE %xxx%） */
  table_name?: string;
  /** 按 blocked 精确过滤 */
  blocked?: 0 | 1;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function listTableRules(
  objectId: number,
  opts: ListTableRulesOptions = {}
): PageResult<TableRuleRow> {
  getObject(objectId); // 404 兜底
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = ["object_id = ?"];
  const args: unknown[] = [objectId];

  if (opts.table_name) {
    conditions.push("table_name LIKE ?");
    args.push(`%${opts.table_name}%`);
  }
  if (opts.blocked !== undefined) {
    conditions.push("blocked = ?");
    args.push(opts.blocked);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const db = getDb();

  const total = (db.prepare(`SELECT COUNT(*) FROM object_table ${where}`).get(...args) as { "COUNT(*)": number })["COUNT(*)"];
  const items = db
    .prepare(`SELECT * FROM object_table ${where} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...args, pageSize, offset) as TableRuleRow[];

  return { items, total, page, pageSize };
}

export function createTableRule(input: {
  object_id: number;
  table_name: string;
  blocked?: number;
  allow_select?: number;
  allow_insert?: number;
  allow_update?: number;
  allow_delete?: number;
  allow_batch_insert?: number;
  allow_batch_update?: number;
  allow_batch_delete?: number;
}): TableRuleRow {
  const objectId = input.object_id;
  if (!objectId || objectId <= 0) {
    throw new BusinessError(400, "object_id 必填");
  }
  getObject(objectId);
  assertIdentifier(input.table_name, "表名");
  try {
    const info = getDb()
      .prepare(
        `INSERT INTO object_table(object_id, table_name, blocked, allow_select, allow_insert, allow_update, allow_delete, allow_batch_insert, allow_batch_update, allow_batch_delete)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        objectId,
        input.table_name,
        input.blocked ? 1 : 0,
        input.allow_select === undefined ? 1 : input.allow_select ? 1 : 0,
        input.allow_insert === undefined ? 1 : input.allow_insert ? 1 : 0,
        input.allow_update === undefined ? 1 : input.allow_update ? 1 : 0,
        input.allow_delete === undefined ? 1 : input.allow_delete ? 1 : 0,
        input.allow_batch_insert === undefined ? 1 : input.allow_batch_insert ? 1 : 0,
        input.allow_batch_update === undefined ? 1 : input.allow_batch_update ? 1 : 0,
        input.allow_batch_delete === undefined ? 1 : input.allow_batch_delete ? 1 : 0
      );
    return getDb()
      .prepare("SELECT * FROM object_table WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as TableRuleRow;
  } catch (e) {
    if (String((e as Error)?.message ?? "").includes("UNIQUE")) {
      throw new BusinessError(409, `该项目的表 "${input.table_name}" 已有限制规则`);
    }
    throw e;
  }
}

export function updateTableRule(
  ruleId: number,
  input: {
    blocked?: number;
    allow_select?: number;
    allow_insert?: number;
    allow_update?: number;
    allow_delete?: number;
    allow_batch_insert?: number;
    allow_batch_update?: number;
    allow_batch_delete?: number;
  }
): TableRuleRow {
  const rule = getDb()
    .prepare("SELECT * FROM object_table WHERE id = ?")
    .get(ruleId) as TableRuleRow | undefined;
  if (!rule) throw new BusinessError(404, `限制规则不存在: ${ruleId}`);

  const flag = (v: number | undefined, old: number) => (v === undefined ? old : v ? 1 : 0);

  getDb()
    .prepare(
      `UPDATE object_table SET blocked = ?, allow_select = ?, allow_insert = ?, allow_update = ?, allow_delete = ?,
       allow_batch_insert = ?, allow_batch_update = ?, allow_batch_delete = ?
       WHERE id = ?`
    )
    .run(
      flag(input.blocked, rule.blocked),
      flag(input.allow_select, rule.allow_select),
      flag(input.allow_insert, rule.allow_insert),
      flag(input.allow_update, rule.allow_update),
      flag(input.allow_delete, rule.allow_delete),
      flag(input.allow_batch_insert, rule.allow_batch_insert),
      flag(input.allow_batch_update, rule.allow_batch_update),
      flag(input.allow_batch_delete, rule.allow_batch_delete),
      ruleId
    );
  return getDb().prepare("SELECT * FROM object_table WHERE id = ?").get(ruleId) as TableRuleRow;
}

export function deleteTableRule(ruleId: number): void {
  const info = getDb()
    .prepare("DELETE FROM object_table WHERE id = ?")
    .run(ruleId);
  if (info.changes === 0) throw new BusinessError(404, `限制规则不存在: ${ruleId}`);
}

/**
 * 查询项目数据源中的所有表信息（用于管理端选取表名添加到 object_table）。
 * @param objectId 项目 ID
 * @param excludeTables 需要排除的表名数组（可选）
 */
export async function getDatabaseInfo(objectId: number, excludeTables?: string[], tableName?: string): Promise<TableInfo[]> {
  const obj = getObject(objectId);
  if (obj.enabled === 0) {
    throw new BusinessError(403, `项目已被禁用: ${obj.name}`);
  }
  const ds = getDs(obj.name);
  return await ds.listTables(excludeTables, tableName);
}

// ============================== 访问控制解析 ==============================

export interface ObjectAccess {
  object: ObjectRow;
  /** 实际执行 SQL 的数据源名称 */
  dsName: string;
  /** 若请求携带有效 Bearer token 且通过 verify，此处返回解析后的 JWT payload（用户 object_id / username 等）；匿名时 null */
  caller: JwtPayload | null;
}

/**
 * 系统管理员阈值：users.object_id == SYSTEM_ADMIN_OBJECT_ID。
 * -1 语义：可以访问所有 object 的接口，且可以调用 /api/config/* / /api/users 管理写接口。
 */
export const SYSTEM_ADMIN_OBJECT_ID = -1;

/**
 * 用户与 object 的绑定关系校验。
 *
 * 规则（按优先级从高到低，任一命中就给出精确的错误文案）：
 *   1. caller 是系统管理员（object_id === -1）→ 无条件放行，不受「表白名单」约束之外的项目级限制。
 *   2. caller 已登录（object_id !== -1，>=1 绑定某具体项目）→ 仅 caller.object_id === currentObj.id 允许，
 *        否则 403 "you are bound to object=<uid>, access to object=<currentName> forbidden"。
 *   3. caller 匿名（null）→ 仅当 object.auth_required=0（本来就允许匿名访问）允许；若 object.auth_required=1
 *        则调用方在 resolveObjectAccess 上面第 2 步已经抛过 401，不会走到这。
 */
export function assertCallerObjectBinding(caller: JwtPayload | null, obj: ObjectRow): void {
  if (!caller) return; // 匿名：由 auth_required=0 场景已经允许
  if (caller.object_id === SYSTEM_ADMIN_OBJECT_ID) return; // 系统管理员：所有项目放行
  if (caller.object_id === obj.id) return; // 绑定到当前项目，放行

  throw new BusinessError(
    403,
    `用户"${caller.username}"被绑定到项目 object_id=${caller.object_id}，无权访问项目"${obj.name}"(object_id=${obj.id})`
  );
}

/**
 * 对调用方要求是「系统管理员」(JWT.object_id === -1)。
 * 若 Bearer token 缺失/无效/不是 admin → 401/403。
 * 用在所有管理端写接口：/api/config/objects CRUD、/api/config/query-templates CRUD、/api/users 写操作。
 * 管理端读接口（GET 列表/详情）目前对所有已登录 system admin 放通 —— 其他绑定用户 403。
 *
 * @param auth.token      Bearer token（HTTP 头 Authorization: Bearer <x>）
 * @param auth.fingerprint 客户端指纹，用于 verifyToken 时序安全比对
 * @returns 有效的管理员 JWT payload；永远不会返回 null（要么成功，要么 throw BusinessError）
 */
export async function requireSystemAdmin(auth: { token?: string; fingerprint: string }): Promise<JwtPayload> {
  if (!auth.token)
    throw new BusinessError(
      401,
      "missing bearer token | 缺少 Bearer token (sysadmin required) | 缺少 Bearer token（需要系统管理员）"
    );
  const payload = await verifyToken(auth.token, auth.fingerprint); // 签名/过期/指纹/TV 任一失败 401
  if (payload.object_id !== SYSTEM_ADMIN_OBJECT_ID) {
    throw new BusinessError(
      403,
      `需要系统管理员（users.object_id=-1）才能访问管理端写接口；当前用户"${payload.username}"被绑定到 object_id=${payload.object_id}`
    );
  }
  return payload;
}

/**
 * 管理端面板专属入口守卫（比 requireSystemAdmin 更严格）：
 *   1. 有效 JWT + 指纹匹配 + tv 检查（verifyToken）
 *   2. object_id === -1 （系统管理员）
 *   3. payload.scope === "admin-panel" （只能从 .env ADMIN_USERNAME/ADMIN_PASSWORD 登录得到）
 *
 * 没有 admin-panel scope 的 legacy admin 用户（users 表里 object_id=-1 的行）
 * 也无法通过此守卫，实现「admin 面板只能被 admin-vue 前端访问」的隔离目标。
 */
export async function requireAdminPanel(auth: { token?: string; fingerprint: string }): Promise<JwtPayload> {
  const payload = await requireSystemAdmin(auth);
  if (payload.scope !== "admin-panel") {
    throw new BusinessError(
      403,
      `此接口仅限管理端面板访问（需要 admin-panel scope）；当前 token 无此 scope。`
    );
  }
  return payload;
}

/**
 * 管理端 GET 读接口的「宽松 admin」校验：
 *   - 不强制要求系统管理员（可选对所有已登录用户放行，但按用户 object_id 过滤列表）
 *   - 目前策略：所有管理端读/写都需要 system admin 准入（和写接口一致），避免 demo 等绑定用户
 *     能看到别的 object 定义/模板定义里的敏感结构（SQL 占位、数据源绑定）。
 * 若将来需要「绑定用户可看自己项目」的读接口，可以把这个函数改成 return payload 并过滤列表。
 */
export async function requireSystemAdminForManage(auth: {
  token?: string;
  fingerprint: string;
}): Promise<JwtPayload> {
  // 所有管理端路由现在统一用 requireAdminPanel 守卫（更严格：额外要求 scope=admin-panel）
  return await requireAdminPanel(auth);
}

/**
 * 通用接口访问控制（严格白名单模式，强制执行）：
 *
 * 调用示例：GET /api/sqlite_demo/product
 *   objectName = "sqlite_demo"  ← URL 第一段，即 object.name
 *   tableName  = "product"      ← URL 第二段，即 object_table.table_name
 *   operation  = "select"       ← select / insert / update / delete
 *
 * 访问控制链（严格强制执行，任何一关不通过即抛 BusinessError）：
 *
 *   ① 先查 object_table WHERE table_name = ?（全局、不指定 object_id）
 *      → 找不到任何行 → 403 "非法访问：数据表 "${tableName}" 未在 object_table 中设置访问权限"
 *      （原因：管理员必须通过 /api/config/objects/:id/tables 为每张表显式声明允许访问）
 *
 *   ② 从 object_table 候选集中反查 object 表：
 *      SELECT o.* FROM object_table ot
 *      JOIN object o ON o.id = ot.object_id
 *      WHERE ot.table_name = ? AND o.name = ?
 *      → 找不到 → 404 "非法访问：数据表 "${tableName}" 不属于任何名为 "${objectName}" 的项目"
 *
 *   ③ object 找到 → 取数据库连接配置（db_type / db_url / db_path）
 *      + auth_required（是否需要登录）
 *
 *   ④ 认证（auth_required=1 时强制 Bearer token + 客户端指纹 + tv 代次）
 *      → 无效 / 过期 / 指纹不匹配 → 401
 *
 *   ⑤ 配置库自保护：禁止通过通用接口读写 object / object_table / users
 *      → sqlite_app 项目下访问这些表 → 403 "配置库表 xxx 不允许通过通用接口访问"
 *
 *   ⑥ 数据源已在 registry 注册（有问题 → 503 让调用方稍后重试）
 *
 *   ⑦ 表级限制（object_table 行本身已在步骤①拿到）：
 *      · blocked = 1 → 403 "表 xxx 已被禁止访问"
 *      · allow_<op> = 0 → 403 "表 xxx 禁止 <op> 操作"
 *
 * —— 关于白名单 ——
 *   本函数**始终强制白名单模式**：任何表必须在 object_table 中显式声明才能访问。
 *   不再有"项目没有任何 object_table 行就放行所有表"的黑名单回退。
 *   这符合安全最小权限原则：管理员逐一勾选哪些表开放、哪些操作允许。
 */
export async function resolveObjectAccess(
  objectName: string,
  tableName: string,
  operation: Operation,
  auth: { token?: string; fingerprint: string }
): Promise<ObjectAccess> {
  // ================================================
  // ① 先查 object 表（按 URL 第一段 object.name）
  // ================================================
  const obj = getDb().prepare("SELECT * FROM object WHERE name = ?").get(objectName) as
    | ObjectRow
    | undefined;
  if (!obj)
    throw new BusinessError(404, `项目 "${objectName}" 不存在`);

  // ================================================
  // ② 项目级开关：enabled=0 → 所有请求一律拒绝（优先级最高）
  // ================================================
  if (obj.enabled === 0) {
    throw new BusinessError(403, `项目 "${objectName}" 已被禁用，拒绝所有请求`);
  }

  // ================================================
  // ③ 配置库自保护：sqlite_app 下禁止访问 guarded tables
  //    （优先级最高：不管 object_table 有没有声明这些表的规则，一律拒绝）
  // ================================================
  if (obj.name === "sqlite_app" && CONFIG_GUARDED_TABLES.has(tableName)) {
    throw new BusinessError(403, `配置库表 "${tableName}" 不允许通过通用接口访问`);
  }

  // ================================================
  // ④ 全局强制白名单：object_table 必须有一行匹配 (obj.id, tableName)
  //    找不到 → 403 "表未声明访问权限"
  // ================================================
  const rule = getDb()
    .prepare(
      `SELECT ot.*, o.name AS _object_name
       FROM object_table ot
       JOIN object o ON o.id = ot.object_id
       WHERE ot.table_name = ? AND o.name = ?`
    )
    .get(tableName, objectName) as (TableRuleRow & { _object_name: string }) | undefined;

  if (!rule) {
    // 确认：object_table 中是否存在任意一条 table_name=目标表 的行？
    const hasAnyRowForTable = (
      getDb().prepare("SELECT COUNT(*) AS c FROM object_table WHERE table_name = ?").get(tableName) as {
        c: number;
      }
    ).c;
    if (hasAnyRowForTable === 0) {
      throw new BusinessError(
        403,
        `非法访问：数据表 "${tableName}" 未在 object_table 中设置访问权限（请管理员先通过 /api/config/objects/${obj.id}/tables 声明该表）`
      );
    }
    // 该表名在其他项目中有规则，但不在当前项目下
    throw new BusinessError(
      403,
      `非法访问：数据表 "${tableName}" 在项目 "${objectName}" 中未声明白名单（object_table 中有 ${hasAnyRowForTable} 个项目声明了该表）`
    );
  }

  // ================================================
  // ⑤ 认证（auth_required=1 强制 Bearer token）
  // ================================================
  let caller: JwtPayload | null = null;
  if (obj.auth_required === 1) {
    if (!auth.token) throw new BusinessError(401, "missing bearer token | 缺少 Bearer token（该项目要求登录）");
    caller = await verifyToken(auth.token, auth.fingerprint);
  } else if (auth.token) {
    // auth_required=0 但调用方也带了 token → 尝试解析（不强制失败），
    // 用于管理员 object_id=-1 / 绑定用户访问非强制认证项目时，仍能过绑定校验。
    try {
      caller = await verifyToken(auth.token, auth.fingerprint);
    } catch {
      caller = null;
    }
  }

  // ================================================
  // ⑥ 用户→项目绑定校验
  // ================================================
  assertCallerObjectBinding(caller, obj);

  // ================================================
  // ⑦ 数据源已在 registry 注册
  // ================================================
  if (!hasDs(obj.name)) {
    throw new BusinessError(503, `项目 "${objectName}" 的数据源尚未初始化，请稍后重试`);
  }

  // ================================================
  // ⑧ 表级限制（blocked + allow_<op>）
  //    单条 insert/update/delete 和 batch_insert/batch_update/batch_delete
  //    各走各的开关；blocked=1 优先级最高。
  // ================================================
  if (rule.blocked === 1) {
    throw new BusinessError(403, `表 "${tableName}" 已被禁止访问（blocked）`);
  }
  const allowed = {
    select: rule.allow_select,
    insert: rule.allow_insert,
    update: rule.allow_update,
    delete: rule.allow_delete,
    batch_insert: rule.allow_batch_insert,
    batch_update: rule.allow_batch_update,
    batch_delete: rule.allow_batch_delete
  }[operation];
  if (allowed === 0) {
    throw new BusinessError(403, `表 "${tableName}" 禁止 ${operation} 操作`);
  }

  return { object: obj, dsName: obj.name, caller };
}
