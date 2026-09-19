/**
 * PostgreSQL 数据源 adapter（骨架桩，预留未完成，查询/事务方法尚未接真实驱动）。
 *
 * 接入步骤（用户自行启用，不强制依赖）：
 *   1. pnpm add pg，并把下方 query/run/transaction 桩替换为真实 pg 实现
 *   2. 在 object 表建一行：db_type=postgres，db_url=postgres://user:pass@host:5432/dbname
 *   3. 在 service 里：const db = getDs("<object.name>");
 */

import type { Datasource, RunResult, TableInfo } from "./types.js";
import type { DataSourceDecl } from "../config/env.js";

export class PostgresDataSource implements Datasource {
  public readonly type = "postgres";
  public readonly name: string;
  public readonly url: string;

  constructor(decl: DataSourceDecl) {
    if (decl.type !== "postgres")
      throw new Error(`PostgresDataSource: ${decl.name} type!=postgres`);
    this.name = decl.name;
    this.url = decl.url ?? "";
  }

  async open(): Promise<void> {
    console.warn(
      `[ds][${this.name}] PostgreSQL adapter 骨架桩（未启用 pg driver）。启用说明见 src/datasources/postgres.ts 头部。`
    );
  }

  async close(): Promise<void> {
    // noop (桩)
  }

  async query<T extends object = Record<string, unknown>>(
    _sql: string,
    _params?: unknown[]
  ): Promise<T[]> {
    throw new Error(
      `[ds][${this.name}] PostgreSQL driver 未启用，无法 query。请 pnpm add pg 并实现本类。`
    );
  }

  async run(_sql: string, _params?: unknown[]): Promise<RunResult> {
    throw new Error(`[ds][${this.name}] PostgreSQL driver 未启用。`);
  }

  async transaction<T>(fn: (tx: Datasource) => Promise<T>): Promise<T> {
    return fn(this); // 桩：无真正事务
  }

  async listTables(_excludeTables?: string[], _tableName?: string): Promise<TableInfo[]> {
    throw new Error(
      `[ds][${this.name}] PostgreSQL driver 未启用，无法 listTables。请 pnpm add pg 并实现本类。`
    );
  }
}

/* ==========================================================================
 * ===== 接入示例（取消下列注释 + 运行 pnpm add pg 即可真实启用）=====
 * 说明：
 *   - 占位符：pg 原生使用 $1 / $2 / ... 序号占位；示例代码里额外做了「把
 *     本接口的 params[] 统一转为 pg 占位符」，避免 Service 层为不同 DB 改 SQL。
 *   - 连接池：pg.Pool 默认 10 连接，自动 idle 回收。
 *   - 事务：client 级 BEGIN / fn / COMMIT / ROLLBACK。
 * ----------------------------------------------------------------
import type { Pool, PoolClient } from "pg";

// —— 替换类里以下 2 个私有字段：
// private _pool: Pool | null = null;
// private _txClient: WeakMap<Datasource, PoolClient> = new WeakMap();

// function convertPlaceholders(sql: string): { sql: string } {
//   // 把 SQL 里的 ? 占位按出现顺序转为 $1 $2 …（仅限简单场景；字符串字面量内含 ? 不处理）
//   let i = 0;
//   const out = sql.replace(/\?/g, () => `$${++i}`);
//   return { sql: out };
// }
//
// async open(): Promise<void> {
//   const pgModule = await import("pg");
//   const PoolCtor = pgModule.Pool;
//   this._pool = new PoolCtor({ connectionString: this.url });
//   const { rows } = await this._pool.query("SELECT 1 AS ok");
//   console.log(`[ds][${this.name}] pg connected, ping=${JSON.stringify(rows)}`);
// }
//
// async close(): Promise<void> {
//   await this._pool?.end();
//   this._pool = null;
// }
//
// async query<T extends object = Record<string, unknown>>(
//   sql: string, params: unknown[] = []
// ): Promise<T[]> {
//   const client = this._txClient.get(this) ?? (this._pool as Pool);
//   const { sql: pgSql } = convertPlaceholders(sql);
//   const { rows } = await client.query(pgSql, params as any[]);
//   return rows as T[];
// }
//
// async run(sql: string, params: unknown[] = []): Promise<RunResult> {
//   const client = this._txClient.get(this) ?? (this._pool as Pool);
//   const { sql: pgSql } = convertPlaceholders(sql);
//   // INSERT 建议自己在 SQL 末尾写 RETURNING id, 1 AS affected；这里给一个兜底实现：
//   const result = await (client as any).query(pgSql + " RETURNING 1 AS _r", params as any[]);
//   const rowCount = Number(result.rowCount ?? 0);
//   const lastId = result.rows?.[0]?.id ? Number(result.rows[0].id) : 0;
//   return { lastInsertRowid: lastId, changes: rowCount };
// }
//
// async transaction<T>(fn: (tx: Datasource) => Promise<T>): Promise<T> {
//   const client = await (this._pool as Pool).connect();
//   try {
//     await client.query("BEGIN");
//     this._txClient.set(this, client);
//     const r = await fn(this);
//     await client.query("COMMIT");
//     return r;
//   } catch (e) {
//     await client.query("ROLLBACK");
//     throw e;
//   } finally {
//     this._txClient.delete(this);
//     client.release();
//   }
// }
========================================================================== */
