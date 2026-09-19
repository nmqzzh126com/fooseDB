/**
 * 通用表结构发现工具：运行时从数据库自身元数据获取列信息。
 *
 * - SQLite: PRAGMA table_info(table)
 * - MySQL:  SHOW COLUMNS FROM table
 *
 * 用于 generic.service.ts 动态构建安全的 SQL（列名白名单 + 主键定位）。
 *
 * 性能优化：discoverSchema 结果按 `${dsName}:${table}` 缓存，表结构变更极低频（DDL），
 * 缓存在管理端执行表结构刷新/ALTER TABLE 时由调用方主动 invalidate（通过 invalidateSchema()）。
 * 这样实现「热路径零额外开销 + 变更主动生效」的平衡。
 */

import type { Datasource } from "../datasources/types.js";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue: string | null;
}

export interface TableSchema {
  table: string;
  columns: ColumnInfo[];
  columnNames: Set<string>;
  primaryKey: string | null;
}

/** 校验表名：只允许字母/下划线开头 + 字母数字下划线，防 SQL 注入 */
export function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/** 根据数据库类型给标识符加引号（MySQL 用反引号，SQLite 用双引号） */
export function quoteId(name: string, dsType: string): string {
  return dsType === "mysql" ? `\`${name}\`` : `"${name}"`;
}

// —— discoverSchema 结果缓存 ——
const _schemaCache = new Map<string, TableSchema>();

/** 构造缓存 key */
function cacheKey(dsName: string, table: string): string {
  return `${dsName}:${table}`;
}

/**
 * 使某张表的 schema 缓存失效。
 * 管理端执行 ALTER TABLE / DROP TABLE / 刷新表结构 时调用。
 */
export function invalidateSchema(dsName: string, table: string): void {
  _schemaCache.delete(cacheKey(dsName, table));
}

/**
 * 使整个数据源的 schema 缓存失效。
 * 管理端执行 删库/重建/整库迁移 时调用。
 */
export function invalidateAllSchemas(dsName?: string): void {
  if (!dsName) {
    _schemaCache.clear();
  } else {
    const prefix = dsName + ":";
    for (const k of _schemaCache.keys()) {
      if (k.startsWith(prefix)) _schemaCache.delete(k);
    }
  }
}

/** 当前缓存命中数（用于健康检查 / 调试） */
export function schemaCacheSize(): number {
  return _schemaCache.size;
}

export async function discoverSchema(ds: Datasource, table: string): Promise<TableSchema> {
  if (!isValidIdentifier(table)) {
    throw new Error(`Invalid table name(无效表名): ${table}`);
  }

  const key = cacheKey(ds.name, table);
  const cached = _schemaCache.get(key);
  if (cached) return cached;

  let columns: ColumnInfo[] = [];

  if (ds.type === "sqlite") {
    const rows = await ds.query<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>(`PRAGMA table_info(${quoteId(table, "sqlite")})`);
    columns = rows.map(r => ({
      name: r.name,
      type: r.type,
      nullable: r.notnull === 0,
      isPrimaryKey: r.pk > 0,
      defaultValue: r.dflt_value
    }));
  } else if (ds.type === "mysql") {
    const rows = await ds.query<{
      Field: string;
      Type: string;
      Null: string;
      Key: string;
      Default: string | null;
    }>(`SHOW COLUMNS FROM ${quoteId(table, "mysql")}`);
    columns = rows.map(r => ({
      name: r.Field,
      type: r.Type,
      nullable: r.Null === "YES",
      isPrimaryKey: r.Key === "PRI",
      defaultValue: r.Default
    }));
  } else {
    throw new Error(`Schema discovery not supported for type(不支持的数据库类型): ${ds.type}`);
  }

  if (columns.length === 0) {
    throw new Error(`Table not found(表不存在):  ${table}`);
  }

  const pkCol = columns.find(c => c.isPrimaryKey);
  const schema: TableSchema = {
    table,
    columns,
    columnNames: new Set(columns.map(c => c.name)),
    primaryKey: pkCol?.name ?? "id"
  };

  _schemaCache.set(key, schema);
  return schema;
}
