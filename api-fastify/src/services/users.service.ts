/**
 * User 业务域 Service：
 *   - 所有 SQL 只在这里写（路由层不写 prepare/query）
 *   - 数据源静态绑定 sqlite_app（方案 A）
 *   - 返回纯数据对象 + 抛 BusinessError 传状态码给路由层
 *
 * 2026-09-18：roles 字段从 users 表剥离到 role_user + roles 表（多对多）。
 *   - UserRow.roles 改成虚拟字段 RoleBrief[]（查询后动态 attachRoles 注入）
 *   - CreateUserInput / UpdateUserInput 不再接受 roles
 *   - 角色绑定改走 /api/role-users/* 接口
 */

import { getDs } from "../datasources/registry.js";
import { BusinessError } from "../utils/errors.js";
import { hashPassword, onUserCredentialChanged } from "./auth.service.js";
import { getDb } from "../db.js";

/** 角色简要信息（从 role_user + roles JOIN 出来的虚拟字段） */
export interface RoleBrief {
  id: number;
  role_name: string;
  flag: number; // 0=启用, 1=禁用
}

export interface UserRow {
  id: number;
  username: string;
  nickname: string | null;
  object_id: number;
  created_at: number;
  flag: number;
  avatar?: string | null;
  permissions?: string | null;
  /** 虚拟字段：从 role_user + roles 表 JOIN 出来的角色列表 */
  roles: RoleBrief[];
  email?: string | null;
  phone?: string | null;
  extended?: string | null;
}

export interface CreateUserInput {
  username: string;
  password: string;
  nickname?: string | null;
  /** -1=系统管理员, >=1=绑定某个object项目, 0=禁止登录 */
  object_id?: number;
  flag?: number;
  email?: string | null;
  phone?: string | null;
  avatar?: string | null;
  permissions?: string | null;
  extended?: string | null;
}

export interface UpdateUserInput {
  username?: string;
  nickname?: string | null;
  password?: string;
  /** 改 object_id 绑定（-1/0/>=1）；若改值≠旧值 → bump token_version 让旧 access 立刻失效 */
  object_id?: number;
  flag?: number;
  email?: string | null;
  phone?: string | null;
  avatar?: string | null;
  permissions?: string | null;
  extended?: string | null;
}

export interface ListUsersFilter {
  /** 按 object_id 精确过滤 */
  object_id?: number;
  /** 按 flag 精确过滤 */
  flag?: number;
}

const DS_NAME = "sqlite_app";

/**
 * 校验 object_id 的合法性：
 *   -1：系统管理员（允许）
 *    0：保留值（"账号禁用" 语义；login/refresh 中会拒绝），这里允许写入（管理员想封禁用户用）
 *  >=1：必须是真实存在的 object.id（通过 app.db object 表校验）
 */
function assertValidObjectId(value: number | undefined, label: string): number {
  if (value === undefined || value === null) return -1; // 未传 = 系统管理员（DB 默认）
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    throw new BusinessError(400, `${label} 必须是整数`);
  }
  const n = Math.trunc(value);
  if (n === -1 || n === 0) return n;
  if (n >= 1) {
    const exists = getDb().prepare("SELECT 1 AS ok FROM object WHERE id = ? LIMIT 1").get(n) as
      { ok: number } | undefined;
    if (!exists) {
      throw new BusinessError(400, `${label}=${n} 无效：object 表中不存在 id=${n} 的项目`);
    }
  }
  return n;
}

function assertValidFlag(value: number | undefined): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new BusinessError(400, `flag 必须是非负整数；实际 ${value}`);
  }
  return value;
}

export interface ListUsersFilter {
  object_id?: number;
  flag?: number;
  username?: string;
  nickname?: string;
}

export interface ListUsersOptions {
  page?: number;
  pageSize?: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 工具：给一批 user rows 挂上 roles 虚拟字段（RoleBrief[]）。
 * 用 getDb()（better-sqlite3 同步）直接查 app.db 的 role_user + roles。
 * 批量 N+1 合并成 1 次查询，O(B) 绑定数返回。
 */
export interface AttachRolesOptions {
  /** 数据源名；缺省则走 app.db（getDb()） */
  dsName?: string;
  /** 关联表名，默认 "role_user"；业务库可能叫 "foose_role_user" */
  userRoleTable?: string;
  /** 角色表名，默认 "roles"；业务库可能叫 "foose_roles" */
  roleTable?: string;
  /** 关联表指向用户的列名，默认 "user_id" */
  userFkCol?: string;
  /** 关联表指向角色的列名，默认 "role_id" */
  roleFkCol?: string;
}

export async function attachRoles<T extends { id: number }>(
  rows: T[],
  opts: AttachRolesOptions = {}
): Promise<(T & { roles: RoleBrief[] })[]> {
  if (rows.length === 0) return rows.map(r => ({ ...r, roles: [] as RoleBrief[] }));
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");

  const {
    dsName,
    userRoleTable = "role_user",
    roleTable = "roles",
    userFkCol = "user_id",
    roleFkCol = "role_id"
  } = opts;

  let bindings: Array<{ [k: string]: unknown }>;
  if (dsName) {
    // —— 业务库走 generic datasource（async） ——
    const ds = getDs(dsName);
    bindings = await ds.query(
      `SELECT ru.${userFkCol} AS _uid, r.id, r.role_name, r.flag
       FROM "${userRoleTable}" ru
       LEFT JOIN "${roleTable}" r ON ru.${roleFkCol} = r.id
       WHERE ru.${userFkCol} IN (${placeholders})`,
      ids
    );
  } else {
    // —— admin-panel 走 app.db 固定库（better-sqlite3 同步） ——
    const db = getDb();
    bindings = db
      .prepare(
        `SELECT ru.${userFkCol} AS _uid, r.id, r.role_name, r.flag
         FROM ${userRoleTable} ru
         LEFT JOIN ${roleTable} r ON ru.${roleFkCol} = r.id
         WHERE ru.${userFkCol} IN (${placeholders})`
      )
      .all(...ids) as Array<{ _uid: number; id: number; role_name: string; flag: number }>;
  }

  const map = new Map<number, RoleBrief[]>();
  for (const b of bindings as Array<{
    _uid: number;
    id: number;
    role_name: string;
    flag: number;
  }>) {
    if (!map.has(b._uid)) map.set(b._uid, []);
    map.get(b._uid)!.push({ id: b.id, role_name: b.role_name, flag: b.flag });
  }
  return rows.map(row => ({
    ...row,
    roles: map.get(row.id) ?? []
  }));
}

const USER_SELECT_COLS =
  "id, username, nickname, object_id, created_at, flag, avatar, permissions, email, phone, extended";

export async function listUsers(
  filter?: ListUsersFilter,
  opts?: ListUsersOptions
): Promise<PageResult<UserRow>> {
  const db = getDs(DS_NAME);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter?.object_id !== undefined) {
    clauses.push("object_id = ?");
    params.push(filter.object_id);
  }
  if (filter?.flag !== undefined) {
    clauses.push("flag = ?");
    params.push(filter.flag);
  }
  if (filter?.username) {
    clauses.push("username LIKE ?");
    params.push(`%${filter.username}%`);
  }
  if (filter?.nickname) {
    clauses.push("nickname LIKE ?");
    params.push(`%${filter.nickname}%`);
  }
  const whereSql = clauses.length ? " WHERE " + clauses.join(" AND ") : "";

  // COUNT 总数
  const countSql = `SELECT COUNT(*) AS cnt FROM users${whereSql}`;
  const countRow = await db.query<{ cnt: number }>(countSql, params);
  const total = countRow[0]?.cnt ?? 0;

  // 分页查询
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, opts?.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  const sql =
    `SELECT ${USER_SELECT_COLS} FROM users` + whereSql + " ORDER BY id DESC" + " LIMIT ? OFFSET ?";
  const rows = (await db.query<UserRow>(sql, [...params, pageSize, offset])) as UserRow[];

  // 挂 roles 虚拟字段
  const items = await attachRoles(rows);
  return { items, total, page, pageSize };
}

export async function getUser(id: number): Promise<UserRow> {
  const db = getDs(DS_NAME);
  const rows = await attachRoles(
    (await db.query<UserRow>(`SELECT ${USER_SELECT_COLS} FROM users WHERE id = ? LIMIT 1`, [
      id
    ])) as UserRow[]
  );
  if (rows.length === 0) throw new BusinessError(404, "User not found | 用户不存在");
  return rows[0];
}

export async function createUser(input: CreateUserInput): Promise<UserRow> {
  const db = getDs(DS_NAME);
  const objectId = assertValidObjectId(input.object_id ?? 0, "object_id");
  const flag = assertValidFlag(input.flag ?? 0);
  const hashedPw = await hashPassword(input.password);
  try {
    // 动态拼 INSERT：带哪些字段取决于传入了啥
    const cols = ["username", "password", "object_id", "flag"];
    const values: unknown[] = [input.username, hashedPw, objectId, flag];
    if (input.nickname !== undefined) {
      cols.push("nickname");
      values.push(input.nickname ?? null);
    }
    if (input.email !== undefined) {
      cols.push("email");
      values.push(input.email ?? null);
    }
    if (input.phone !== undefined) {
      cols.push("phone");
      values.push(input.phone ?? null);
    }
    if (input.avatar !== undefined) {
      cols.push("avatar");
      values.push(input.avatar ?? null);
    }
    if (input.permissions !== undefined) {
      cols.push("permissions");
      values.push(input.permissions ?? null);
    }
    if (input.extended !== undefined) {
      cols.push("extended");
      values.push(input.extended ?? null);
    }

    const placeholders = cols.map(() => "?").join(",");
    const res = await db.run(
      `INSERT INTO users(${cols.join(", ")}) VALUES(${placeholders})`,
      values
    );
    const id = Number(res.lastInsertRowid);

    // 返回完整记录 + 挂 roles
    const rows = await attachRoles(
      (await db.query<UserRow>(`SELECT ${USER_SELECT_COLS} FROM users WHERE id = ? LIMIT 1`, [
        id
      ])) as UserRow[]
    );
    return rows[0];
  } catch (e: any) {
    if (String(e?.message ?? "").includes("UNIQUE")) {
      throw new BusinessError(409, "用户名已存在");
    }
    throw e;
  }
}

export async function updateUser(id: number, input: UpdateUserInput): Promise<UserRow> {
  const db = getDs(DS_NAME);
  const existing = getDb()
    .prepare("SELECT id, object_id, flag, username FROM users WHERE id = ? LIMIT 1")
    .get(id) as { id: number; object_id: number; flag: number; username: string } | undefined;
  if (!existing) throw new BusinessError(404, "User not found | 用户不存在");

  // 用户名变更：校验唯一 + bump TV
  let usernameChanging = false;
  if (input.username !== undefined && input.username !== existing.username) {
    if (!input.username || input.username.length === 0) {
      throw new BusinessError(400, "用户名不能为空");
    }
    const dup = getDb()
      .prepare("SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1")
      .get(input.username) as { id: number } | undefined;
    if (dup) throw new BusinessError(409, "用户名已存在");
    usernameChanging = true;
  }

  // 密码变更：非空时才哈希；空字符串 / undefined 表示不变
  const hashedPw =
    input.password && input.password.length > 0 ? await hashPassword(input.password) : null;
  const passwordChanging = hashedPw != null;

  // object_id 变更：校验新值；若与旧不同 → 触发 bump TV + invalidate refresh
  let newObjectId: number | undefined;
  let objectIdChanging = false;
  if (input.object_id !== undefined) {
    newObjectId = assertValidObjectId(input.object_id, "object_id");
    if (newObjectId !== existing.object_id) objectIdChanging = true;
  }

  const flagChanging = input.flag !== undefined && input.flag !== existing.flag;
  const safeFlag = input.flag !== undefined ? assertValidFlag(input.flag) : null;

  // 动态拼 SET：只 SET 传入的字段（undefined 不动，null/"" 会覆盖）
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.username !== undefined) {
    sets.push("username = ?");
    params.push(input.username);
  }
  if (input.nickname !== undefined) {
    sets.push("nickname = ?");
    params.push(input.nickname ?? null);
  }
  if (hashedPw != null) {
    sets.push("password = ?");
    params.push(hashedPw);
  }
  if (input.object_id !== undefined && objectIdChanging) {
    sets.push("object_id = ?");
    params.push(newObjectId!);
  }
  if (input.flag !== undefined) {
    sets.push("flag = ?");
    params.push(safeFlag!);
  }
  if (input.email !== undefined) {
    sets.push("email = ?");
    params.push(input.email ?? null);
  }
  if (input.phone !== undefined) {
    sets.push("phone = ?");
    params.push(input.phone ?? null);
  }
  if (input.avatar !== undefined) {
    sets.push("avatar = ?");
    params.push(input.avatar ?? null);
  }
  if (input.permissions !== undefined) {
    sets.push("permissions = ?");
    params.push(input.permissions ?? null);
  }
  if (input.extended !== undefined) {
    sets.push("extended = ?");
    params.push(input.extended ?? null);
  }

  if (sets.length === 0) {
    // 没有任何字段变更 — 直接返回当前记录
    const rows = await attachRoles(
      (await db.query<UserRow>(`SELECT ${USER_SELECT_COLS} FROM users WHERE id = ? LIMIT 1`, [
        id
      ])) as UserRow[]
    );
    return rows[0];
  }

  params.push(id);
  const res = await db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
  if (res.changes === 0) throw new BusinessError(404, "User not found | 用户不存在");

  if (passwordChanging || objectIdChanging || flagChanging || usernameChanging) {
    // 改密 / 改绑定 / 改 flag / 改用户名 → 立即 bump TV + 撤销 refresh 家族
    onUserCredentialChanged(id, true);
  }

  // 返回完整记录（不含 password）+ 挂 roles
  const rows = await attachRoles(
    (await db.query<UserRow>(`SELECT ${USER_SELECT_COLS} FROM users WHERE id = ? LIMIT 1`, [
      id
    ])) as UserRow[]
  );
  return rows[0];
}

export async function deleteUser(id: number): Promise<void> {
  const db = getDs(DS_NAME);
  const res = await db.run("DELETE FROM users WHERE id = ?", [id]);
  if (res.changes === 0) throw new BusinessError(404, "User not found | 用户不存在");
  // 级联清理 role_user 绑定
  getDb().prepare("DELETE FROM role_user WHERE user_id = ?").run(id);
}

export interface BatchUpdateUsersInput {
  userIds: number[];
  flag?: number;
  password?: string;
}

export interface BatchUpdateResult {
  ok: true;
  updated: number;
  password_changed: number;
  flag_changed: number;
}

/**
 * 批量修改用户 flag 和/或密码。
 * - userIds: 必填，至少 1 个
 * - flag: 可选，改则校验 + bump TV
 * - password: 可选，非空才 bcrypt hash + bump TV
 */
export async function batchUpdateUsers(input: BatchUpdateUsersInput): Promise<BatchUpdateResult> {
  const db = getDs(DS_NAME);

  if (!input.userIds || input.userIds.length === 0) {
    throw new BusinessError(400, "userIds 至少 1 个");
  }
  if (input.userIds.length > 200) {
    throw new BusinessError(400, "单次最多 200 个");
  }
  // 去重
  const ids = [...new Set(input.userIds)];
  const placeholders = ids.map(() => "?").join(",");

  // 查出要改的用户，校验存在性
  const existingRows = await db.query<{ id: number; flag: number }>(
    `SELECT id, flag FROM users WHERE id IN (${placeholders})`,
    ids
  );
  if (existingRows.length === 0) {
    throw new BusinessError(404, "没有匹配的用户");
  }

  const flagChanging = input.flag !== undefined;
  const passwordChanging = input.password && input.password.length > 0;

  if (!flagChanging && !passwordChanging) {
    throw new BusinessError(400, "至少传 flag 或 password 之一");
  }

  // 密码 hash（跟 createUser / updateUser 用同一个 hashPassword）
  const hashedPw = passwordChanging ? await hashPassword(input.password!) : null;

  const safeFlag = flagChanging ? assertValidFlag(input.flag!) : null;

  // 动态拼 UPDATE：SET 什么取决于用户传了啥
  const setClauses: string[] = [];
  const params: unknown[] = [];
  if (passwordChanging) {
    setClauses.push("password = ?");
    params.push(hashedPw!);
  }
  if (flagChanging) {
    setClauses.push("flag = ?");
    params.push(safeFlag!);
  }
  params.push(...ids);

  const res = await db.run(
    `UPDATE users SET ${setClauses.join(", ")} WHERE id IN (${placeholders})`,
    params
  );

  // bump TV + 撤销 refresh 家族 — 所有被改的用户都要
  for (const row of existingRows) {
    if (passwordChanging || flagChanging) {
      onUserCredentialChanged(row.id, true);
    }
  }

  return {
    ok: true,
    updated: res.changes,
    password_changed: passwordChanging ? res.changes : 0,
    flag_changed: flagChanging ? res.changes : 0
  };
}
