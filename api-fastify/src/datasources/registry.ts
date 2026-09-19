/**
 * 数据源注册表（命名中心 + 启动初始化 + 动态注册/注销 + 优雅关闭）。
 *
 * 启动时：
 *   1. registerAll() — 注册内置 sqlite_app（配置库 app.db）
 *   2. bulkRegisterObjectDsFromDb() — 扫描 object 表，为每行注册数据源
 *
 * 运行时：
 *   - createObject → registerObjectDs(row)
 *   - updateObject → reregisterObjectDs(row)（连接参数变更时）
 *   - deleteObject → unregisterObjectDs(name)
 *   - resolveObjectAccess → 若 registry 中没有该 object 的 DS，懒注册
 *
 * Service 层调用：
 *   1. getDs(name)            → 按名拿 Datasource（key = object.name）
 *   2. getDefaultDs()         → 兜底主库（sqlite_app）
 *   3. getAllStatuses()       → 健康检查
 *   4. closeAll()              → 停机时调用
 */

import type { Datasource } from "./types.js";
import type { DataSourceDecl } from "../config/env.js";
import { SqliteDataSource } from "./sqlite.js";
import { MysqlDataSource } from "./mysql.js";
import { PostgresDataSource } from "./postgres.js";
import { getDb } from "../db.js";
import { invalidateAllSchemas } from "../utils/schema.js";

const _store = new Map<string, Datasource>();
let _initialized = false;

export interface DsStatus {
  name: string;
  type: string;
  status: "unknown" | "ok" | "error";
  error?: string;
}

function build(decl: DataSourceDecl): Datasource {
  switch (decl.type) {
    case "sqlite":
      return new SqliteDataSource(decl);
    case "mysql":
      return new MysqlDataSource(decl);
    case "postgres":
      return new PostgresDataSource(decl);
    default:
      throw new Error(`[ds registry] 未知数据源类型：${decl.type}`);
  }
}

/** 只注册内置 sqlite_app（配置库 app.db），不再从 .env 读 DS_* */
export async function registerAll(): Promise<void> {
  if (_initialized) return;
  // 内置 sqlite_app：配置库
  const builtin: DataSourceDecl = { name: "sqlite_app", type: "sqlite" };
  if (!_store.has("sqlite_app")) {
    const ds = build(builtin);
    await ds.open();
    _store.set("sqlite_app", ds);
  }
  _initialized = true;
  console.log(
    `[ds registry] init done: ${_store.size} 个数据源。[${[..._store.keys()].join(", ")}]`
  );
}

/** object 行 → DataSourceDecl → 构建 Datasource → open() → 注册 */
export async function registerObjectDs(row: {
  name: string;
  db_type: string;
  db_url?: string | null;
  db_path?: string | null;
}): Promise<void> {
  if (_store.has(row.name)) return; // 幂等
  const decl: DataSourceDecl = {
    name: row.name,
    type: row.db_type as "sqlite" | "mysql" | "postgres",
    url: row.db_url ?? undefined,
    path: row.db_path ?? undefined
  };
  const ds = build(decl);
  await ds.open();
  _store.set(row.name, ds);
}

/** 注销数据源（关闭连接 + 从 map 移除 + 清 schema 缓存） */
export async function unregisterObjectDs(name: string): Promise<void> {
  const ds = _store.get(name);
  if (!ds) return; // 幂等
  try {
    await ds.close();
  } catch (e) {
    console.error(`[ds registry][${name}] close 失败:`, e);
  }
  _store.delete(name);
  invalidateAllSchemas(name);
}

/** 连接参数变更时重新注册（先关旧连接再开新的） */
export async function reregisterObjectDs(row: {
  name: string;
  db_type: string;
  db_url?: string | null;
  db_path?: string | null;
}): Promise<void> {
  // sqlite_app 的连接是全局单例，不能关/重建
  if (row.name === "sqlite_app") return;
  await unregisterObjectDs(row.name);
  await registerObjectDs(row);
}

/** 启动时扫描 object 表，为每行注册数据源（跳过已注册的 sqlite_app） */
export async function bulkRegisterObjectDsFromDb(): Promise<void> {
  const rows = getDb().prepare("SELECT name, db_type, db_url, db_path FROM object").all() as {
    name: string;
    db_type: string;
    db_url: string | null;
    db_path: string | null;
  }[];
  for (const row of rows) {
    if (_store.has(row.name)) continue; // 跳过已注册的
    try {
      await registerObjectDs(row);
    } catch (e) {
      console.warn(`[ds registry] object "${row.name}" 注册失败:`, e);
    }
  }
}

/** 按名字拿 Datasource。找不到抛错。 */
export function getDs(name: string): Datasource {
  const ds = _store.get(name);
  if (!ds) {
    const available = [..._store.keys()].join(", ") || "<空>";
    throw new Error(`[ds registry] 找不到数据源 "${name}"。可用：${available}。`);
  }
  return ds;
}

/** 检查数据源是否已注册（不抛错） */
export function hasDs(name: string): boolean {
  return _store.has(name);
}

export function getDefaultDs(): Datasource {
  return getDs("sqlite_app");
}

/** 健康检查：逐个 ds 检查状态 */
export function getAllStatuses(): DsStatus[] {
  const arr: DsStatus[] = [];
  for (const [name, ds] of _store) {
    const s: DsStatus = { name, type: ds.type, status: "unknown" };
    try {
      s.status = "ok";
    } catch (e: any) {
      s.status = "error";
      s.error = String(e?.message ?? e);
    }
    arr.push(s);
  }
  return arr;
}

/** 优雅停机：逐个 ds.close() */
export async function closeAll(): Promise<void> {
  if (!_initialized) return;
  for (const ds of _store.values()) {
    try {
      await ds.close();
    } catch (e) {
      console.error(`[ds registry][${ds.name}] close 失败:`, e);
    }
  }
  _store.clear();
  _initialized = false;
}
