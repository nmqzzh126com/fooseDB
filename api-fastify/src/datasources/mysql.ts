/**
 * MySQL 数据源 adapter（mysql2/promise 真实实现）。
 *
 * 使用方式：
 *   1. 在 object 表建一行项目（管理端 /api/config/objects）：
 *        db_type=mysql，db_url=mysql://user:pass@host:3306/dbname
 *      启动 / 创建项目时 registry 自动用本 adapter 注册连接，key = object.name。
 *   2. 在 service 里：
 *        import { getDs } from "../datasources/registry.js";
 *        const db = getDs("<object.name>");
 *   3. 无对应 mysql 类型项目时本 adapter 不会被实例化（动态 import，零启动开销）。
 */

import type { Pool, PoolConnection } from "mysql2/promise";
import type { Datasource, RunResult, TableInfo } from "./types.js";
import type { DataSourceDecl } from "../config/env.js";

export class MysqlDataSource implements Datasource {
  public readonly type = "mysql";
  public readonly name: string;
  public readonly url: string;

  private _pool: Pool | null = null;
  /** 事务进行中时指向事务专用连接，query/run 走它保证同一会话 */
  private _txConn: PoolConnection | null = null;

  constructor(decl: DataSourceDecl) {
    if (decl.type !== "mysql") throw new Error(`MysqlDataSource: ${decl.name} type!=mysql`);
    this.name = decl.name;
    this.url = decl.url ?? "";
  }

  async open(): Promise<void> {
    if (this._pool) return;
    const mysql = await import("mysql2/promise");
    const url = new URL(this.url); // mysql://user:pass@host:port/db
    this._pool = mysql.createPool({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      waitForConnections: true,
      connectionLimit: 10
    });
    // ping 一次，让启动时立即暴露连接串错误
    await this._pool.query("SELECT 1 AS ok");
    console.log(
      `[ds][${this.name}] mysql2 connected: ${url.hostname}:${url.port || 3306}/${url.pathname.replace(/^\//, "")}`
    );
  }

  async close(): Promise<void> {
    if (!this._pool) return;
    await this._pool.end();
    this._pool = null;
  }

  async query<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const conn = this._txConn ?? this._pool;
    if (!conn) throw new Error(`[ds][${this.name}] MySQL not open`);
    const [rows] = await conn.query(sql, params);
    return rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const conn = this._txConn ?? this._pool;
    if (!conn) throw new Error(`[ds][${this.name}] MySQL not open`);
    const [result] = (await conn.execute(sql as any, params as any)) as [
      { insertId?: number; affectedRows?: number },
      unknown
    ];
    return {
      lastInsertRowid: Number(result.insertId ?? 0),
      changes: Number(result.affectedRows ?? 0)
    };
  }

  async transaction<T>(fn: (tx: Datasource) => Promise<T>): Promise<T> {
    if (!this._pool) throw new Error(`[ds][${this.name}] MySQL not open`);
    const conn = await this._pool.getConnection();
    try {
      await conn.beginTransaction();
      this._txConn = conn;
      const r = await fn(this);
      await conn.commit();
      return r;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      this._txConn = null;
      conn.release();
    }
  }

  async listTables(excludeTables?: string[], tableName?: string): Promise<TableInfo[]> {
    const conn = this._txConn ?? this._pool;
    if (!conn) throw new Error(`[ds][${this.name}] MySQL not open`);
    const exclude = excludeTables?.filter(Boolean) ?? [];
    const like = tableName?.trim() ? `%${tableName.trim()}%` : null;
    let sql =
      "SELECT table_name AS name, table_comment AS comment, table_rows AS `rows` FROM information_schema.tables WHERE table_schema = DATABASE()";
    const params: string[] = [];
    if (like) { sql += " AND table_name LIKE ?"; params.push(like); }
    // 每个排除项都是 NOT LIKE '%xxx%' 模糊匹配
    for (const ex of exclude) {
      sql += " AND table_name NOT LIKE ?";
      params.push(`%${ex}%`);
    }
    sql += " ORDER BY table_name";
    const [rows] = await conn.query(sql, params);
    return (rows as Array<{ name: string; comment: string; rows: number }>).map(r => ({
      name: r.name,
      comment: r.comment || undefined,
      rows: r.rows ?? undefined
    }));
  }
}
