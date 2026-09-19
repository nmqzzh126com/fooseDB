/**
 * FoosDB 后端对接示例
 * ===================================================================
 *
 * 本文件展示如何在 admin-vue（pure-admin 框架）中对接 FoosDB 后端（物理目录 api-fastify）。
 * 内容覆盖：HTTP 客户端配置（URL/指纹/响应解包）、认证流程、
 * admin-panel 专属接口、通用业务 CRUD、自定义 SQL 执行。
 *
 * 所有示例可直接复制到 src/api/ 目录下作为生产代码使用。
 *
 * 依赖：
 *   import Axios from "axios";
 *   import Cookies from "js-cookie";     // pure-admin 已内置
 *   import { storageLocal } from "@pureadmin/utils"; // 已内置
 */

/* ================================================================
 * 0. HTTP 客户端（替换/扩展 pure-admin 默认的 http 实例）
 * ================================================================ */

import Axios, { type AxiosInstance } from "axios";
import Cookies from "js-cookie";
import { extractCn, getClientId } from "@/utils/http";

// 保持向后兼容 —— fastify.ts 原本也导出 extractCn / getClientId
export { extractCn, getClientId };

export type MyDbType = "sqlite" | "mysql" | "postgres" | "mongodb" | "redis" | "mssql";
export interface DbConnection {
  label: string;
  value: MyDbType;
  example: string;
  disabled: boolean;// 是否禁用
}
//常用数据库连接字符串
export const dbConnectionList: DbConnection[] = [
  {
    label: "SQLite",
    value: "sqlite",
    example: "/home/user/db/sqlite.db",
    disabled: false,
  },
  {
    label: "MySQL",
    value: "mysql",
    example: "mysql://user:pass@host:3306/dbname",
    disabled: false,
  },
  {
    label: "PostgreSQL",
    value: "postgres",
    example: "postgres://user:pass@host:5432/dbname",
    disabled: true,
  },
  {
    label: "MongoDB",
    value: "mongodb",
    example: "mongodb://user:pass@host:27017/dbname",
    disabled: true,
  },
  {
    label: "Redis",
    value: "redis",
    example: "redis://username:mypassword@host:6379/0",
    disabled: true,
  },
  {
    label: "Microsoft SQL Server",
    value: "mssql",
    example: "mssql://user:pass@host:1433/dbname",
    disabled: true,
  }
];

export const getDbConnectionExample =
  (dbType: MyDbType) => dbConnectionList.find(item => item.value === dbType)?.example || "";

// —— 后端基础地址（Vite dev server 把 /api 代理到 http://localhost:8858）——
export const API_BASE = "/api";

// —— 扩展 axios：自动加指纹头 + 自动加 Bearer token + 解包后端响应格式 ——
export function createFastifyClient(): AxiosInstance {
  const client = Axios.create({
    baseURL: API_BASE,
    timeout: 15000,
    headers: { "Content-Type": "application/json", Accept: "application/json" }
  });

  // 请求拦截：注入 X-Client-Id 和 Authorization
  client.interceptors.request.use(config => {
    config.headers = (config.headers ?? {}) as typeof config.headers;
    config.headers["X-Client-Id"] = getClientId();

    // 从 cookie 读 token（pure-admin 原有存储方式）
    const tokenCookie = Cookies.get("authorized-token");
    if (tokenCookie) {
      try {
        const { accessToken } = JSON.parse(tokenCookie);
        if (accessToken) config.headers["Authorization"] = `Bearer ${accessToken}`;
      } catch {
        /* ignore */
      }
    }
    return config;
  });

  // 响应拦截：解包 Fastify 外层 + 统一错误
  //
  // 后端三种实际返回格式：
  //   ① 认证接口（/api/auth/*）  {"data":{access_token,...}}   → 1 key 外层 → 解包
  //   ② 写操作 admin 路由        {"ok":true, "row":{...}}     → 2 key，含 ok  → 保留完整
  //   ③ 通用 CRUD（generic.ts）  纯对象 / 列表                → 不含 data key → 保留
  //
  // 之前的 "Object.keys === 1" 启发式会误判：如果某业务行刚好只有 data 一个字段（极罕见）
  // 会被提前拆包。这里改成「白名单 + 保留 ok 兜底」的策略——
  // 只对明确返回 {data} 单 key 的认证接口做强解包，其他都原样返回。
  //
  client.interceptors.response.use(
    res => {
      const body = res.data;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        // ok 在根上的 → admin/config/* / admin/db/* 写操作，保留完整
        if ("ok" in body) return body;
        // 后端包装 {data: ...} 且只有 data 一个根字段 → 解包拿内层
        if ("data" in body && Object.keys(body).length === 1) return body.data;
        // 其他情况（generic CRUD 直接返回纯对象/列表）→ 原样透传
      }
      return body;
    },
    err => {
      const status = err.response?.status ?? 0;
      const raw = err.response?.data?.error ?? err.message;
      const display = extractCn(raw, `请求失败 (${status})`);

      if (status === 401) {
        // token 过期 / 指纹不匹配 / refresh 被复用 —— 强制重新登录
        Cookies.remove("authorized-token");
        localStorage.removeItem("user-info");
        window.location.href = "/login";
      }
      return Promise.reject(new Error(display));
    }
  );

  return client;
}

// 全局单例（也可以放到 pure-admin 的 src/utils/http/index.ts 里替换默认实例）
export const fastify = createFastifyClient();

/* ================================================================
 * 1. 认证接口 — /api/auth/*
 * ================================================================ */

/**
 * 安全解码 JWT payload（base64url 格式）。
 *
 * JWT 规范使用 base64url（RFC 4648 §5），字符集是 `-` / `_` + 无 `=` padding；
 * 而浏览器原生 `atob()` 只支持标准 base64（`+` / `/` + padding），
 * 直接调用 `atob(base64url)` 遇到 `-` 或 `_` 会抛 InvalidCharacterError，
 * 导致 admin 登录流程必崩。
 *
 * 本函数把 base64url 先转换为标准 base64（替换字符 + 补 padding），
 * 再调 `atob()`，做到浏览器环境下与 Node.js `Buffer.from(str, "base64url")` 等价。
 */
function decodeJwtPayload(jwt: string): LoginResponse["payload"] {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT format");
  let b64 = parts[1]
    .replace(/-/g, "+")   // base64url → base64: - → +
    .replace(/_/g, "/");  // base64url → base64: _ → /
  // 补齐 padding（base64url 省略末尾 `=`）
  const pad = (4 - (b64.length % 4)) % 4;
  b64 += "=".repeat(pad);
  return JSON.parse(atob(b64));
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  /** Unix 时间戳（秒），不是 Date */
  expires: number;
  refresh_expires: number;
  token_type: "Bearer";
  /** admin 登录时 = "admin-panel"；业务用户不存在 */
  scope?: "admin-panel";
  /** JWT payload（base64 解码后） */
  payload: {
    sub: number;
    username: string;
    nickname: string | null;
    object_id: number; // -1 = sysadmin, >=1 = 绑定项目
    scope?: "admin-panel";
    type: "access" | "refresh";
  };
}

/** POST /api/auth/login — 登录（admin 或业务用户自动识别） */
export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await fastify.post<any, LoginResponse>("/auth/login", { username, password });
  // 解 JWT payload 给前端快速判断 scope / object_id（使用 base64url 兼容解码，避免 atob 崩溃）
  const payload = decodeJwtPayload(res.access_token);
  return { ...res, payload };
}

/** POST /api/auth/refresh — 轮换 access_token（必须带与登录相同的 X-Client-Id） */
export async function refresh(refreshToken: string): Promise<LoginResponse> {
  const res = await fastify.post<any, LoginResponse>("/auth/refresh", {
    refresh_token: refreshToken
  });
  const payload = decodeJwtPayload(res.access_token);
  return { ...res, payload };
}

/** POST /api/auth/logout — 登出（可带 refresh_token 作废整条 family） */
export function logout(refreshToken?: string) {
  return fastify.post<any, { revoked: number }>(
    "/auth/logout",
    refreshToken ? { refresh_token: refreshToken } : {}
  );
}

/** GET /api/auth/me — 验证当前 token，返回用户基本信息 */
export function me() {
  return fastify.get<
    any,
    {
      id: number;
      username: string;
      nickname: string;
      object_id: number;
      token_version: number;
      expires: number;
    }
  >("/auth/me");
}

/* ================================================================
 * 2. /api/admin/db/* — admin-panel 专属数据操作
 *    （scope="admin-panel" 的 JWT 才能访问）
 * ================================================================ */

export interface DbTableInfo {
  name: string; // 表名
  rows: number; // 行数
  indexes: number; // 索引数
}

export interface DbRow extends Record<string, unknown> {
  id: number;
}

export interface WalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

/** GET /api/admin/db/tables — 列出 app.db 所有表 + 行数 */
export function listTables() {
  return fastify.get<any, { ok: true; tables: DbTableInfo[] }>("/admin/db/tables");
}

/** GET /api/admin/db/table/:name?limit=&offset= — 查表数据 */
export function queryTable(table: string, limit = 50, offset = 0) {
  return fastify.get<
    any,
    { ok: true; table: string; limit: number; offset: number; rows: DbRow[] }
  >(`/admin/db/table/${encodeURIComponent(table)}`, { params: { limit, offset } });
}

/** POST /api/admin/db/query — 执行参数化 SELECT（仅 SELECT / PRAGMA） */
export function runQuery(sql: string, params?: unknown[] | Record<string, unknown>) {
  return fastify.post<any, { ok: true; rows: Record<string, unknown>[] }>("/admin/db/query", {
    sql,
    params
  });
}

/** POST /api/admin/db/insert — 插入行 */
export function insertRow(table: string, data: Record<string, unknown>) {
  return fastify.post<any, { ok: true; table: string; changes: number; lastInsertRowid: number }>(
    "/admin/db/insert",
    { table, data }
  );
}

/** POST /api/admin/db/update — 更新行（必须带 WHERE） */
export function updateRow(
  table: string,
  data: Record<string, unknown>,
  where: string,
  whereParams?: unknown[]
) {
  return fastify.post<any, { ok: true; table: string; changes: number }>("/admin/db/update", {
    table,
    data,
    where,
    whereParams: whereParams ?? []
  });
}

/** POST /api/admin/db/delete — 删除行（必须带 WHERE，防误删全表） */
export function deleteRow(table: string, where: string, whereParams?: unknown[]) {
  return fastify.post<any, { ok: true; table: string; changes: number }>("/admin/db/delete", {
    table,
    where,
    whereParams: whereParams ?? []
  });
}

/** POST /api/admin/db/refresh-tokens/cleanup — 手动清理过期 refresh_tokens */
export function cleanupExpiredRefreshTokens() {
  return fastify.post<any, { ok: true; removed: number }>("/admin/db/refresh-tokens/cleanup", {});
}

/**
 * POST /api/admin/db/checkpoint — WAL checkpoint（TRUNCATE 模式）
 *
 * ⚠️ better-sqlite3 pragma 返回数组 [{busy, log, checkpointed}] 不是对象
 *    如果 wal 正在忙碌（busy > 0），checkpoint 会被跳过
 */
export function walCheckpoint() {
  return fastify.post<any, { ok: true; result: WalCheckpointResult[] }>("/admin/db/checkpoint", {});
}

/** GET /api/admin/db/meta — 数据库元信息（仪表盘用） */
export function dbMeta() {
  return fastify.get<
    any,
    {
      ok: true;
      journalMode: string; // "wal"
      tables: number;
      rowCounts: {
        object: number;
        users: number;
        refresh_tokens: number;
        refresh_tokens_expired: number;
      };
      wal: WalCheckpointResult[];
    }
  >("/admin/db/meta");
}

/* ================================================================
 * 3. /api/config/* — 项目管理（admin-panel 专属）
 * ================================================================ */

export interface ObjectDef {
  id: number;
  name: string; // 唯一（项目名，决定通用 API 路径第一段）
  description: string | null;
  auth_required: 0 | 1; // 0=匿名可访问；1=需 Bearer token
  db_type: MyDbType;
  db_url: string | null; // mysql/postgres 用
  db_path: string | null; // sqlite 用（默认 getDbPath()）
  cors_origins: string;
  cors_methods: string;
  custom_sql_enabled?: 0 | 1; // 是否允许 /api/custom/*
  enabled: 0 | 1; // 项目启用/禁用（0=禁用，拒绝所有请求）
  created_at?: number;
  _user_count?: number;// 项目下用户数--虚拟字段
  _table_count?: number;// 项目下表数--虚拟字段
}

/** GET /api/config/objects — 项目列表 */
export function listObjects() {
  return fastify.get<any, ObjectDef[]>("/config/objects");
}
/** GET /api/config/objects/:id — 项目详情 */
export function getObjectDetail(id: number) {
  return fastify.get<any, ObjectDef>(`/config/objects/${id}`);
}


/** POST /api/config/objects — 新建项目 */
export function createObject(body: Partial<ObjectDef>) {
  return fastify.post<any, ObjectDef>("/config/objects", body);
}

/** PUT /api/config/objects/:id — 更新项目 */
export function updateObject(id: number, body: Partial<ObjectDef>) {
  return fastify.put<any, ObjectDef>(`/config/objects/${id}`, body);
}

/** POST /api/config/objects/test-connection — 测试数据源连接（临时连接，不注册） */
export function testConnection(params: {
  db_type: MyDbType;
  db_url?: string | null;
  db_path?: string | null;
}) {
  return fastify.post<any, { ok: boolean; message?: string }>("/config/objects/test-connection", params);
}

/** DELETE /api/config/objects/:id — 删除项目（级联删其 table rules） */
export function deleteObject(id: number) {
  return fastify.delete<any, { ok: true; changes: number }>(`/config/objects/${id}`);
}

// —— 表级权限规则 ——
export interface TableRule {
  id: number;
  object_id: number;
  table_name: string;
  blocked: 0 | 1; // 1=全禁；0=用 allow_* 精细化
  allow_select: 0 | 1;
  allow_insert: 0 | 1;
  allow_update: 0 | 1;
  allow_delete: 0 | 1;
  allow_batch_insert: 0 | 1;
  allow_batch_update: 0 | 1;
  allow_batch_delete: 0 | 1;
  created_at: number;
}

/** GET /api/config/objects/:id/tables — 某项目的表级规则 */
/** 分页结果通用结构 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListTableRulesParams {
  page?: number;
  pageSize?: number;
  table_name?: string;
  blocked?: 0 | 1;
}

/** GET /api/config/objects/:id/tables — 表级规则列表（支持分页 + 过滤） */
export function listTableRules(objectId: number, params?: ListTableRulesParams) {
  if (!objectId || objectId <= 0) {
    return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 50 } as PageResult<TableRule>);
  }
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  if (params?.table_name) qs.set("table_name", params.table_name);
  if (params?.blocked !== undefined) qs.set("blocked", String(params.blocked));
  const suffix = qs.toString();
  return fastify.get<any, PageResult<TableRule>>(
    `/config/objects/${objectId}/tables${suffix ? `?${suffix}` : ""}`
  );
}

/** 取总数（用 pageSize=1 只拉一条，从响应拿 total） */
export async function countTableRules(objectId: number): Promise<number> {
  if (!objectId || objectId <= 0) return 0;
  const page = await listTableRules(objectId, { page: 1, pageSize: 1 });
  return page.total ?? 0;
}

/** POST /api/config/objects/:id/tables — 新增表级规则 */
/** POST /api/config/tables — 创建表级规则（object_id 在 body 里） */
export function createTableRule(body: {
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
}) {
  return fastify.post<any, TableRule>(`/config/tables`, body);
}

/** PUT /api/config/tables/:ruleId — 更新表级规则（ruleId 主键，无需 objectId） */
export function updateTableRule(
  ruleId: number,
  body: Partial<Omit<TableRule, "id" | "table_name">>
) {
  return fastify.put<any, TableRule>(`/config/tables/${ruleId}`, body);
}

/** DELETE /api/config/tables/:ruleId — 删除表级规则（ruleId 主键，无需 objectId） */
export function deleteTableRule(ruleId: number) {
  return fastify.delete<any, { ok: true; changes: number }>(
    `/config/tables/${ruleId}`
  );
}

/** 数据库表信息 */
export interface DatabaseTableInfo {
  name: string;
  comment?: string;
  rows?: number;
}

/** GET /api/config/objects/:id/dbinfo — 查询项目数据源中的所有表 */
export function getDataBaseInfo(objectId: number, excludeTableNames?: string[], tableName: string = "") {
  if (!objectId || objectId <= 0) {
    return Promise.resolve([] as DatabaseTableInfo[]);
  }
  const parts: string[] = [];
  if (excludeTableNames && excludeTableNames.length > 0) {
    excludeTableNames.forEach(n => parts.push(`excludeTable=${encodeURIComponent(n)}`));
  }
  if (tableName.trim()) {
    parts.push(`tableName=${encodeURIComponent(tableName.trim())}`);
  }
  const suffix = parts.length > 0 ? `?${parts.join("&")}` : "";
  return fastify.get<any, DatabaseTableInfo[]>(
    `/config/objects/${objectId}/dbinfo${suffix}`
  );
}

/* ================================================================
 * 4. /api/users/* — 业务用户管理（admin-panel 专属）
 * ================================================================ */

export interface BusinessUser {
  id: number;
  username: string;
  nickname: string | null;
  password: string | null;
  object_id: number;
  token_version?: number;
  extended: string | null;
  avatar: string | null;
  permissions: string | null;
  /** 角色列表（虚拟字段：从 role_user + roles JOIN 出来） */
  roles: Role[];
  email: string | null;
  phone: string | null;
  flag: number;
  created_at?: number;
}

/** GET /api/users — 用户列表 */
export function listUsers() {
  return fastify.get<any, BusinessUser[]>("/users");
}

export interface ListUsersParams {
  page?: number;
  pageSize?: number;
  flag?: number;
  username?: string;
  nickname?: string;
}

/** GET /api/users — 查询用户列表（分页），object_id 通过 params 传入 */
export function listUsersByObject(objectId: number, params?: ListUsersParams) {
  if (!objectId || objectId <= 0) {
    return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 50 } as PageResult<BusinessUser>);
  }
  const qs = new URLSearchParams();
  qs.set("object_id", String(objectId));
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  if (params?.flag !== undefined) qs.set("flag", String(params.flag));
  if (params?.username) qs.set("username", params.username);
  if (params?.nickname) qs.set("nickname", params.nickname);
  return fastify.get<any, PageResult<BusinessUser>>(`/users?${qs.toString()}`);
}
/** GET /api/users?object_id=X&flag=Y — 按项目 + 标记过滤用户数 */
export async function countUsersByObject(objectId: number, flag: number = 0) {
  if (!objectId) return 0;
  if (objectId <= 0) return 0;

  const list = await fastify.get<any, PageResult<BusinessUser>>(`/users?object_id=${objectId}&flag=${flag}`);
  if (list && list.items && list.items.length > 0) return list.items.length;
  return 0;
}

/** GET /api/users/:id — 用户详情 */
export function getUserDetail(id: number) {
  return fastify.get<any, BusinessUser>(`/users/${id}`);
}

/** POST /api/users — 新建业务用户 */
export function createUser(body: {
  username: string;
  password: string;
  nickname?: string;
  object_id: number;
}) {
  return fastify.post<any, BusinessUser>("/users", body);
}

/** PATCH /api/users/:id — 更新用户（object_id 或 password 变化会 bump token_version） */
export function updateUser(id: number, body: Partial<BusinessUser> & { password?: string }) {
  return fastify.patch<any, BusinessUser>(`/users/${id}`, body);
}

/** DELETE /api/users/:id — 删除用户（级联删 refresh_tokens） */
export function deleteUser(id: number) {
  return fastify.delete<any, { ok: true }>(`/users/${id}`);
}

/** POST /api/users/batch-update — 批量修改用户 flag 和/或密码 */
export function batchUpdateUsers(input: {
  userIds: number[];
  flag?: number;
  password?: string;
}) {
  return fastify.post<any, { ok: true; updated: number; password_changed: number; flag_changed: number }>(
    `/users/batch-update`,
    input
  );
}

/* ================================================================
 * 4.2. /api/roles/* + /api/role-users/* — 角色管理（admin-panel 专属）
 * ================================================================ */

export interface Role {
  id: number;
  role_name: string;
  flag: number; // 0=启用, 1=禁用
}

export interface RoleUserBinding {
  id: number;
  role_id: number;
  user_id: number;
  /** JOIN 出来的冗余字段 */
  role_name?: string;
  /** JOIN 出来的冗余字段 — 角色 flag（0=启用,1=禁用） */
  flag?: number;
  /** JOIN 出来的冗余字段 */
  username?: string;
}

/** GET /api/roles — 角色列表 */
export function listRoles(params?: {
  flag?: number;
  role_name?: string;
  /** "like"（默认，模糊匹配 %val%）或 "exact"（精确匹配） */
  mode?: "like" | "exact";
}) {
  const qs = new URLSearchParams();
  if (params?.flag !== undefined) qs.set("flag", String(params.flag));
  if (params?.role_name) qs.set("role_name", params.role_name);
  if (params?.mode) qs.set("mode", params.mode);
  const suffix = qs.toString();
  return fastify.get<any, Role[]>(`/roles${suffix ? `?${suffix}` : ""}`);
}

/** GET /api/roles/batch?ids=1,2,3 — 按主键批量查角色 */
export function listRolesByIds(ids: number[]) {
  if (!ids || ids.length === 0) return Promise.resolve([] as Role[]);
  const qs = ids.join(",");
  return fastify.get<any, Role[]>(`/roles/batch?ids=${encodeURIComponent(qs)}`);
}

/** GET /api/roles/:id — 角色详情 */
export function getRole(id: number) {
  return fastify.get<any, Role>(`/roles/${id}`);
}

/** POST /api/roles — 新建角色 */
export function createRole(body: { role_name?: string; flag?: number }) {
  return fastify.post<any, Role>("/roles", body);
}

/** PUT /api/roles/:id — 更新角色 */
export function updateRole(id: number, body: { role_name?: string; flag?: number }) {
  return fastify.put<any, Role>(`/roles/${id}`, body);
}

/** DELETE /api/roles/:id — 删除角色（级联删 role_user 绑定） */
export function deleteRole(id: number) {
  return fastify.delete<any, { ok: true }>(`/roles/${id}`);
}

/** GET /api/role-users/batch?ids=1,2,3 — 按主键批量查绑定 */
export function listRoleUsersByIds(ids: number[]) {
  if (!ids || ids.length === 0) return Promise.resolve([] as RoleUserBinding[]);
  const qs = ids.join(",");
  return fastify.get<any, RoleUserBinding[]>(`/role-users/batch?ids=${encodeURIComponent(qs)}`);
}

/** GET /api/role-users?role_id=X&user_id=Y — 绑定列表 */
export function listRoleUsers(params?: { role_id?: number; user_id?: number }) {
  const qs = new URLSearchParams();
  if (params?.role_id !== undefined) qs.set("role_id", String(params.role_id));
  if (params?.user_id !== undefined) qs.set("user_id", String(params.user_id));
  const suffix = qs.toString();
  return fastify.get<any, RoleUserBinding[]>(`/role-users${suffix ? `?${suffix}` : ""}`);
}



/** POST /api/role-users — 绑定角色 { role_id, user_id }（幂等） */
export function bindRoleUser(body: { role_id: number; user_id: number }) {
  return fastify.post<any, RoleUserBinding>("/role-users", body);
}

/** DELETE /api/role-users/:id — 解除绑定（按主键） */
export function unbindRoleUser(id: number) {
  return fastify.delete<any, { ok: true }>(`/role-users/${id}`);
}

/** POST /api/role-users/batch-set — 全量设置某用户的角色（先删后插） */
export function batchSetUserRoles(body: { user_id: number; role_ids: number[] }) {
  return fastify.post<any, { ok: true; user_id: number; role_count: number }>(
    "/role-users/batch-set",
    body
  );
}


/* ================================================================
 * 4.5. /api/config/query-templates/* — 自定义 SQL 模板管理（admin-panel 专属）
 * ================================================================ */

export interface QueryTemplate {
  id: number;
  name: string; // 唯一（URL 路径：/api/custom/:name）
  object_id: number; // 绑定项目
  description: string | null;
  sql: string; // 模板 SQL，支持 {{param}} 占位符
  params_schema: string | null; // JSON Schema 字符串，描述参数类型
  created_at: number;
  updated_at: number;
}

/** GET /api/config/query-templates — 模板列表（可选 ?object_id=） */
export function listQueryTemplates(params?: { object_id?: number }) {
  return fastify.get<any, QueryTemplate[]>("/config/query-templates", { params });
}

/** GET /api/config/query-templates/:id — 模板详情 */
export function getQueryTemplate(id: number) {
  return fastify.get<any, QueryTemplate>(`/config/query-templates/${id}`);
}

/** POST /api/config/query-templates — 新建模板 */
export function createQueryTemplate(body: Omit<QueryTemplate, "id" | "created_at" | "updated_at">) {
  return fastify.post<any, QueryTemplate>("/config/query-templates", body);
}

/** PUT /api/config/query-templates/:id — 更新模板 */
export function updateQueryTemplate(
  id: number,
  body: Partial<Omit<QueryTemplate, "id" | "created_at" | "updated_at">>
) {
  return fastify.put<any, QueryTemplate>(`/config/query-templates/${id}`, body);
}

/** DELETE /api/config/query-templates/:id — 删除模板 */
export function deleteQueryTemplate(id: number) {
  return fastify.delete<any, { ok: true; changes: number }>(`/config/query-templates/${id}`);
}

/* ================================================================
 * 5. 通用业务 CRUD — /api/:object/:table/*
 *    鉴权：取决于 object.auth_required
 *    覆盖全部 9 个端点（单条 CRUD + 4 种批量）
 * ================================================================ */

// —— 类型定义（与后端契约对齐）——

/** JOIN 结构化定义（推荐；可序列化为 URL join=term1,term2） */
export interface FooseJoin {
  table: string;
  type?: "one" | "many";
  joinType?: "left" | "inner";
  as?: string;
  on?: string | { local: string; foreign: string };
}

/** Filter 结构化定义（Directus 风格 + 15 种运算符 + OR/AND 嵌套） */
export type FooseFilter = Record<string, unknown>;

/** 列表查询参数（兼容两种写法：结构化 join/joins 或旧 URL 字符串） */
export interface GenericListParams {
  page?: number;
  pageSize?: number;
  /** true = 返回全量（无分页信封） */
  noPage?: boolean;
  /** 向后兼容 nopage 拼写 */
  nopage?: boolean;
  /** true = 按 filter 条件查一行（零结果返回 null，不抛 404） */
  __one?: boolean;
  /** 排序：单字段 "created_at:desc" / 多字段 "created_at:desc,id:asc" */
  orderBy?: string;
  order?: "asc" | "desc";
  fields?: string;
  groupBy?: string;
  /** 调试开关：后端响应额外返回 sql + sqlParams */
  showSql?: boolean;

  // —— JOIN ——
  /** 结构化数组（推荐） */
  joins?: FooseJoin[];
  /** 兼容旧代码的单数字段 — 优先使用 joins（复数） */
  join?: FooseJoin[] | string;

  // —— 过滤 ——
  /** Directus 风格结构化过滤（推荐） */
  filter?: FooseFilter;
  /** 扁平化 WHERE key，如 "status=published" 或 "id[_gte]=100"（旧写法） */
  [key: string]: unknown;
}

/** 列表信封（分页模式） */
export interface GenericPage<T = Record<string, unknown>> {
  data: T[];
  meta: {
    mode: "paginated";
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
  sql?: string;
  sqlParams?: unknown[];
}

/** 批量写操作通用信封 */
export interface GenericBatchEnvelope<T = Record<string, unknown>> {
  ok: true;
  rows?: T[];
  sql?: string;
  sqlParams?: unknown[];
  [key: string]: unknown; // created / updated / deleted 动态字段
}

/* —— 内部工具：把 GenericListParams 里的结构化 joins/join 序列化成 URL 兼容格式 —— */
function serializeJoins(joinVal: FooseJoin[] | string | undefined): string | undefined {
  if (!joinVal) return undefined;
  if (typeof joinVal === "string") return joinVal;
  if (!Array.isArray(joinVal)) return undefined;
  return joinVal
    .map(j => {
      let onPart = "";
      if (typeof j.on === "string") onPart = j.on;
      else if (j.on && typeof j.on === "object") onPart = `${j.on.local}=${j.on.foreign}`;
      const parts = [j.table];
      if (j.type || j.as || onPart || j.joinType) parts.push(j.type ?? "");
      if (j.as || onPart || j.joinType) parts.push(j.as ?? "");
      if (onPart || j.joinType) parts.push(onPart);
      if (j.joinType) parts.push(j.joinType);
      return parts.join(":");
    })
    .join(",");
}

/** GET /api/:object/:table — 分页列表 / 条件查询 / 按条件查一行 */
export function genericList<T = Record<string, unknown>>(
  object: string,
  table: string,
  params?: GenericListParams
): Promise<GenericPage<T>> {
  const { joins, join, filter: _filter, ...rest } = params ?? {};
  const q: Record<string, unknown> = { ...rest };
  const joined = serializeJoins(joins ?? join);
  if (joined) q.join = joined;
  // filter 中的下划线语法（如 status=published）已经在 rest 里自动作为 query key
  return fastify.get<any, GenericPage<T>>(`/${object}/${table}`, { params: q });
}

/** GET /api/:object/:table/:id — 按主键查一行 */
export function genericGet<T = Record<string, unknown>>(
  object: string,
  table: string,
  id: number | string,
  params?: { fields?: string; join?: string | FooseJoin[]; joins?: FooseJoin[] }
): Promise<T> {
  const { join, joins } = params ?? {};
  const q: Record<string, unknown> = {};
  const joined = serializeJoins(joins ?? join);
  if (joined) q.join = joined;
  if (params?.fields) q.fields = params.fields;
  return fastify.get<any, T>(`/${object}/${table}/${id}`, { params: q });
}

/** POST /api/:object/:table — 单条创建（返回 row 本身，自动解包信封） */
export async function genericCreate<T = Record<string, unknown>>(
  object: string,
  table: string,
  data: Record<string, unknown>
): Promise<T> {
  const res = await fastify.post<any, { ok: true; row: T }>(`/${object}/${table}`, data);
  return res.row;
}

/** PUT /api/:object/:table/:id — 单条更新（返回 row 本身，自动解包信封） */
export async function genericUpdate<T = Record<string, unknown>>(
  object: string,
  table: string,
  id: number | string,
  data: Record<string, unknown>
): Promise<T> {
  const res = await fastify.put<any, { ok: true; row: T }>(`/${object}/${table}/${id}`, data);
  return res.row;
}

/** DELETE /api/:object/:table/:id — 单条删除 */
export function genericDelete(
  object: string,
  table: string,
  id: number | string
): Promise<{ ok: true; deleted: 1 }> {
  return fastify.delete<any, { ok: true; deleted: 1 }>(`/${object}/${table}/${id}`);
}

/** POST /api/:object/:table/batch-create — 批量创建（事务原子） */
export function genericCreates<T = Record<string, unknown>>(
  object: string,
  table: string,
  rows: Record<string, unknown>[],
  showSql = false
): Promise<GenericBatchEnvelope<T> & { created: number }> {
  return fastify.post<any, GenericBatchEnvelope<T> & { created: number }>(
    `/${object}/${table}/batch-create${showSql ? "?showSql=1" : ""}`,
    { rows }
  );
}

/** POST /api/:object/:table/batch-update — 批量更新（每行必须带 id，事务原子） */
export function genericUpdates<T = Record<string, unknown>>(
  object: string,
  table: string,
  rows: Array<{ id: number | string } & Record<string, unknown>>,
  showSql = false
): Promise<GenericBatchEnvelope<T> & { updated: number }> {
  return fastify.post<any, GenericBatchEnvelope<T> & { updated: number }>(
    `/${object}/${table}/batch-update${showSql ? "?showSql=1" : ""}`,
    { rows }
  );
}

/** POST /api/:object/:table/batch-delete — 批量按 ids 删除 */
export function genericRemoves(
  object: string,
  table: string,
  ids: Array<number | string>,
  showSql = false
): Promise<{ ok: true; deleted: number; sql?: string; sqlParams?: unknown[] }> {
  return fastify.post<any, { ok: true; deleted: number; sql?: string; sqlParams?: unknown[] }>(
    `/${object}/${table}/batch-delete${showSql ? "?showSql=1" : ""}`,
    { ids }
  );
}

/** POST /api/:object/:table/batch-delete-filter — 批量按 filter 删除（空 filter 默认禁止） */
export function genericRemoveByFilter(
  object: string,
  table: string,
  filter: FooseFilter,
  showSql = false
): Promise<{ ok: true; deleted: number; sql?: string; sqlParams?: unknown[] }> {
  return fastify.post<any, { ok: true; deleted: number; sql?: string; sqlParams?: unknown[] }>(
    `/${object}/${table}/batch-delete-filter${showSql ? "?showSql=1" : ""}`,
    { filter }
  );
}

/* ================================================================
 * 6. /api/custom/:name — 执行自定义 SQL 模板（项目级鉴权）
 * ================================================================ */

export function runCustomSql(name: string, params?: Record<string, unknown>) {
  return fastify.post<any, { ok: true; rows: Record<string, unknown>[]; count: number }>(
    `/custom/${encodeURIComponent(name)}`,
    { params: params ?? {} }
  );
}

/* ================================================================
 * 7. /api/system/* — 运维接口
 * ================================================================ */

/**
 * POST /api/system/restart — 触发后端优雅重启
 *
 * 前置条件：
 *   - .env ALLOW_SYSTEM_RESTART=true（否则端点返回 404 隐藏）
 *   - 登录用户必须是 admin-panel scope
 *   - 进程内 30 秒防重冷却
 *   - 后端由 PM2 / systemd 等守护进程拉起，进程退出后会自动重启
 *
 * ⚠️ 纯 node dist/main.js 没有守护进程时调用 = 服务停掉
 */
export async function triggerRestart(): Promise<{
  ok: true;
  message: string;
  cooldownSec: number;
}> {
  const res = await fastify.post<any, { ok: true; message: string; cooldownSec: number }>(
    "/system/restart",
    {}
  );
  // 后端发完 202 后 1 秒会进程退出，前端应该：
  //   1. 弹 Toast "服务重启中..."
  //   2. 每 2 秒轮询 /health，直到它 200
  //   3. 刷新当前 token（旧 refresh_token 因 family 失效会 401，强制重新登录）
  return res;
}

/** GET /health — 健康检查（后端重启后前端用这个探测恢复） */
export async function waitUntilBackendRecovered(timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch("/health");
      if (res.ok) return true;
    } catch {
      /* 后端还没起来，忽略网络错误 */
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

/* ================================================================
 * 8. Vue 组件中怎么用 — 一个完整示例
 * ================================================================
 *
 * import { ref, onMounted } from "vue";
 * import { login, dbMeta, walCheckpoint, triggerRestart, waitUntilBackendRecovered } from "@/api/fastify";
 *
 * async function onSubmit() {
 *   const res = await login(form.username, form.password);
 *   if (res.payload.scope === "admin-panel") {
 *     // admin 面板用户 → 存 admin-panel 特定状态
 *     store.isAdminPanel = true;
 *     store.objectId = -1;
 *   } else {
 *     store.isAdminPanel = false;
 *     store.objectId = res.payload.object_id;
 *   }
 *   // 把 token 存到 cookie（pure-admin 原有机制）
 *   setToken({ accessToken: res.access_token, refreshToken: res.refresh_token, expires: res.expires * 1000 });
 * }
 *
 * // 仪表盘：读数据库概览
 * const meta = ref<Awaited<ReturnType<typeof dbMeta>>>();
 * onMounted(async () => { meta.value = await dbMeta(); });
 *
 * function onRestart() {
 *   await triggerRestart();
 *   ElMessage.success("服务重启中...");
 *   const ok = await waitUntilBackendRecovered();
 *   ElMessage(ok ? "服务已恢复" : "重启超时，请手动检查");
 *   router.push("/login");
 * }
 */
