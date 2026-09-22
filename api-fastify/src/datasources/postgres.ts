/**
 * PostgreSQL 数据源 adapter（pg.Pool 实现）。
 *
 * 接入方式：
 *   1. 在 object 表建一行项目（管理端 /api/config/objects）：
 *        db_type=postgres，db_url=postgres://user:pass@host:5432/dbname
 *      启动 / 创建项目时 registry 自动用本 adapter 注册连接，key = object.name。
 *   2. Service 层统一写 ? 占位符，adapter 内部自动转为 pg 的 $1/$2/... 序号占位。
 *   3. 连接池 pg.Pool 默认 10 连接，自动 idle 回收。
 */

import type { Pool, PoolClient } from "pg";
import type { Datasource, RunResult, TableInfo } from "./types.js";
import type { DataSourceDecl } from "../config/env.js";

/**
 * 把 SQL 里的 ? 占位符按出现顺序转为 $1 $2 $3 …
 * （简单替换：字符串字面量内含 ? 的场景不处理，Service 层不写这种 SQL）
 */
function convertPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export class PostgresDataSource implements Datasource {
  public readonly type = "postgres";
  public readonly name: string;
  public readonly url: string;

  private _pool: Pool | null = null;
  /** 事务进行中时指向事务专用 client，query/run 走它保证同一会话 */
  private _txClient: PoolClient | null = null;

  constructor(decl: DataSourceDecl) {
    if (decl.type !== "postgres") throw new Error(`PostgresDataSource: ${decl.name} type!=postgres`);
    this.name = decl.name;
    this.url = decl.url ?? "";
  }

  async open(): Promise<void> {
    if (this._pool) return;
    const pg = await import("pg");
    this._pool = new pg.Pool({ connectionString: this.url });
    // ping 一次，让启动时立即暴露连接串错误
    const client = await this._pool.connect();
    try {
      await client.query("SELECT 1 AS ok");
    } finally {
      client.release();
    }
    const u = new URL(this.url);
    console.log(
      `[ds][${this.name}] pg connected: ${u.hostname}:${u.port || 5432}${u.pathname}`
    );
  }

  async close(): Promise<void> {
    if (!this._pool) return;
    await this._pool.end();
    this._pool = null;
  }

  private requirePool(): Pool {
    if (!this._pool) throw new Error(`[ds][${this.name}] PostgreSQL not open`);
    return this._pool;
  }

  private pickClient(): PoolClient | Pool {
    return this._txClient ?? this.requirePool();
  }

  async query<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const client = this.pickClient();
    const pgSql = convertPlaceholders(sql);
    const { rows } = await client.query(pgSql, params);
    return rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const client = this.pickClient();
    const pgSql = convertPlaceholders(sql);
    const result = await client.query(pgSql, params);
    // INSERT 可以带 RETURNING id，UPDATE/DELETE 只靠 rowCount
    const changes = Number(result.rowCount ?? 0);
    let lastId: number | bigint = 0;
    if (result.command === "INSERT" && result.rows.length > 0) {
      const first = result.rows[0] as Record<string, unknown>;
      // pg 约定 INSERT ... RETURNING id 时第一列就是 id
      const idVal = Object.values(first)[0];
      if (typeof idVal === "number") lastId = idVal;
      else if (typeof idVal === "bigint") lastId = idVal;
      else if (idVal != null) lastId = Number(idVal);
    }
    return { lastInsertRowid: lastId, changes };
  }

  async transaction<T>(fn: (tx: Datasource) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      this._txClient = client;
      const result = await fn(this);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* ignore rollback errors */ }
      throw e;
    } finally {
      this._txClient = null;
      client.release();
    }
  }

  async listTables(excludeTables?: string[], tableName?: string): Promise<TableInfo[]> {
    const client = this.pickClient();
    const exclude = excludeTables?.filter(Boolean) ?? [];
    const like = tableName?.trim() ? `%${tableName.trim()}%` : null;

    let sql =
      "SELECT table_name AS name FROM information_schema.tables " +
      "WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'";
    const params: unknown[] = [];
    if (like) {
      sql += " AND table_name LIKE $1";
      params.push(like);
    }
    let placeholderIdx = params.length + 1;
    for (const ex of exclude) {
      sql += ` AND table_name NOT LIKE $${placeholderIdx++}`;
      params.push(`%${ex}%`);
    }
    sql += " ORDER BY table_name";

    const pgSql = convertPlaceholders(sql);
    const { rows } = await client.query(pgSql, params);
    return (rows as Array<{ name: string }>).map(r => ({
      name: r.name,
      comment: undefined,
      rows: undefined
    }));
  }
}
