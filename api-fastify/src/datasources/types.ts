/**
 * 所有数据源（SQLite/MySQL/PG 等）必须实现的统一 Promise 接口。
 *
 * 设计原则：
 *   - Service 层只依赖 Datasource，不依赖任何具体 driver；
 *   - 即使 SQLite 本身是同步 API，也要包装成 Promise，保持签名一致，
 *     方便将来把 users 从 sqlite_app 切到 mysql_orders 时，Service 代码零修改。
 */

/** 表基础信息 */
export interface TableInfo {
  /** 表名 */
  name: string;
  /** 表注释（MySQL 有，SQLite 可能为空） */
  comment?: string;
  /** 预估行数（information_schema.tables.table_rows，可能不准） */
  rows?: number;
}

export interface RunResult {
  /** 插入行的自增主键（MySQL = insertId, SQLite = lastInsertRowid, PG = RETURNING xxx） */
  lastInsertRowid: number | bigint;
  /** 受影响的行数（UPDATE/DELETE） */
  changes: number;
}

export interface Datasource {
  readonly name: string;
  readonly type: "sqlite" | "mysql" | "postgres";

  /** 启动时 registry 自动调用一次：建连接/连接池、执行 DDL、种子数据（可选）。*/
  open(): Promise<void>;

  /** 优雅停机：关闭底层连接/连接池。 */
  close(): Promise<void>;

  /** SELECT / 返回多行。参数按 driver 自适应（sqlite=? 占位 / mysql=? / pg=$1）。*/
  query<T extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** INSERT / UPDATE / DELETE —— 返回行数/主键。 */
  run(sql: string, params?: unknown[]): Promise<RunResult>;

  /** 事务：在同一个 tx 连接上顺序执行 fn；任何抛错自动 ROLLBACK。 */
  transaction<T>(fn: (tx: Datasource) => Promise<T>): Promise<T>;

  /** 获取数据库中所有表的基础信息（用于管理端选取表名）
   * @param excludeTables 需要排除的表名数组（可选）
   * @param tableName 按表名模糊匹配（LIKE %xxx%）
   */
  listTables(excludeTables?: string[], tableName?: string): Promise<TableInfo[]>;
}
