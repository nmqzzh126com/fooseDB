/**
 * SQLite 数据源 adapter：better-sqlite3 同步 API + Datasource 接口。
 *
 * 每个 SqliteDataSource 独立打开自己的 .db 文件，不再共享全局单例。
 * 内置 sqlite_app（配置库 app.db）仍会调用 initDb() 做建表/种子初始化。
 */

import type { Datasource, RunResult, TableInfo } from "./types.js";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { getDbPath } from "../db.js";
import { initDbIfAppDb } from "../db.js";
import type { DataSourceDecl } from "../config/env.js";

export class SqliteDataSource implements Datasource {
  public readonly type = "sqlite";
  public readonly name: string;
  public readonly path: string;

  private db: Database.Database | null = null;

  constructor(decl: DataSourceDecl) {
    if (decl.type !== "sqlite") throw new Error(`SqliteDataSource: ${decl.name} type!=sqlite`);
    this.name = decl.name;
    // 显式路径优先；否则 fallback 到默认 app.db 位置
    this.path = decl.path ?? getDbPath();
  }

  async open(): Promise<void> {
    // 确保目录存在
    const dir = path.dirname(this.path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 业务库（非 app.db）禁止自动创建空库文件 —— 文件不存在应当报错
    // app.db 配置库需要自动创建，由 initDbIfAppDb 负责建表
    const isAppDb = this.path === getDbPath();
    if (!isAppDb && !fs.existsSync(this.path)) {
      throw new Error(`SQLite 数据库文件不存在: ${this.path}`);
    }

    this.db = new Database(this.path);

    // 统一 pragma：WAL + NORMAL + busy_timeout + 外键
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");

    // 配置库 app.db 需要额外建表 + 种子（initDbIfAppDb 内部会检查路径，
    // 只在当前路径 === getDbPath() 时才执行，避免污染业务库）
    if (this.path === getDbPath()) {
      await initDbIfAppDb(this.db);
    }

    console.log(`[ds][${this.name}] opened sqlite: ${this.path}`);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log(`[ds][${this.name}] closed sqlite`);
    }
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error(`[ds][${this.name}] sqlite 连接未打开`);
    return this.db;
  }

  async query<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const db = this.requireDb();
    const stmt = db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const db = this.requireDb();
    const stmt = db.prepare(sql);
    const info = stmt.run(...params);
    return {
      lastInsertRowid: Number(info.lastInsertRowid),
      changes: Number(info.changes)
    };
  }

  async transaction<T>(fn: (tx: Datasource) => Promise<T>): Promise<T> {
    const db = this.requireDb();
    db.prepare("BEGIN").run();
    try {
      const result = await fn(this);
      db.prepare("COMMIT").run();
      return result;
    } catch (e) {
      db.prepare("ROLLBACK").run();
      throw e;
    }
  }

  async listTables(excludeTables?: string[], tableName?: string): Promise<TableInfo[]> {
    const db = this.requireDb();
    const exclude = excludeTables?.filter(Boolean) ?? [];
    const like = tableName?.trim() ? `%${tableName.trim()}%` : null;
    let sql = "SELECT name, '' AS comment FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";
    const params: string[] = [];
    if (like) { sql += " AND name LIKE ?"; params.push(like); }
    // 每个排除项都是 NOT LIKE '%xxx%' 模糊匹配
    for (const ex of exclude) {
      sql += " AND name NOT LIKE ?";
      params.push(`%${ex}%`);
    }
    sql += " ORDER BY name";
    const rows = db.prepare(sql).all(...params) as Array<{ name: string; comment: string }>;
    return rows.map(r => ({ name: r.name, comment: r.comment, rows: undefined }));
  }
}
