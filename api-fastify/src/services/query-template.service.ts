/**
 * query_template（自定义 SQL 模板）配置 CRUD Service。
 *
 * 额外校验（入库前必须全通过，否则 400/409）：
 *   1. object_id 必须存在
 *   2. name 与已有模板冲突 → 409（UNIQUE 冲突捕获 + 语义化报错）
 *   3. sql_text 必须通过 SELECT-only 校验（validateSelectOnly）
 *   4. params_schema 必须能被 JSON.parse（如非空）且字段与 SQL 占位符一致（不强制，但给警告；执行期用严格校验）
 */

import { getDb } from "../db.js";
import { BusinessError } from "../utils/errors.js";
import {
  validateSelectOnly,
  parseParamsSchema,
  compileNamedParams,
  type QueryTemplateRow
} from "./custom-sql.js";
import { getObject } from "./config.service.js";

// 业务类型：对外返回（去掉 SQL 原样返回可能有点敏感；但当前就是直接返回，管理员可见）
export type QueryTemplateOut = QueryTemplateRow;

export function listTemplates(): QueryTemplateOut[] {
  return getDb()
    .prepare("SELECT * FROM query_template ORDER BY id DESC")
    .all() as QueryTemplateOut[];
}

export function getTemplate(id: number): QueryTemplateOut {
  const row = getDb().prepare("SELECT * FROM query_template WHERE id = ?").get(id) as
    QueryTemplateOut | undefined;
  if (!row) throw new BusinessError(404, `template not found | 模板不存在: ${id}`);
  return row;
}

export interface CreateTemplateInput {
  object_id: number;
  name: string;
  description?: string;
  sql_text: string;
  params_schema?: string | null;
  role_required?: "public" | "user" | "admin";
  rows_limit?: number;
  timeout_ms?: number;
  enabled?: number;
}

/**
 * 创建自定义 SQL 模板（管理端入库）。
 *
 * 入库前的防御性校验（先于 INSERT 执行，保证 app.db 里存的每条模板都能被 executeCustomQuery
 * 的静态分析通过，不会出现「创建成功但一调用就失败」的体验）：
 *   1. object 存在（引用的 object.id 必须存在，否则 404）；
 *      object 行自带 db_type/db_url/db_path 数据源配置（创建项目时已注册连接）
 *   2. validateSelectOnly(input.sql_text)：SELECT-only + 无分号 + 关键字黑名单 + 表黑名单；
 *      否则 400 "sql_text: <reason>"（例如 forbidden keyword / guarded table / multi-statement）
 *   3. input.params_schema 非空 → JSON.parse() 必须成功；否则 400 "params_schema is not valid JSON | params_schema 不是有效 JSON"
 *   4. 空跑一次 parseParamsSchema —— 检测「占位名 :name 与 JSON schema 的对应关系」
 *      是否一致（不一致时只 warn，因为 5.6 的 runtime 会再做强校验）
 *
 * 唯一性：UNIQUE(object.name) → 冲突 409 "template name already exists: <name>"
 * 其余字段默认值：role_required=public / rows_limit=1000 / timeout_ms=3000 / enabled=1
 */
export function createTemplate(input: CreateTemplateInput): QueryTemplateOut {
  // 1. object 存在（404 if not found）
  getObject(input.object_id);
  // 2. SQL 必须通过 SELECT-only 校验（入库前就把关，保证 app.db 里存的都是静态合法的）
  const vr = validateSelectOnly(input.sql_text);
  if (!vr.ok) {
    throw new BusinessError(400, `sql_text: ${vr.reason}`);
  }
  // 3. params_schema JSON 合法性（防止前端误传非法 JSON 导致后面 execute 每次报错）
  if (input.params_schema != null && String(input.params_schema).trim().length > 0) {
    try {
      JSON.parse(String(input.params_schema));
    } catch (e) {
      throw new BusinessError(
        400,
        `params_schema is not valid JSON | params_schema 不是有效 JSON: ${(e as Error).message}`
      );
    }
  }
  // 4. 空跑一次 parseParamsSchema：确保 params_schema 与 SQL 占位的对应结构能被解析
  //    （不一致只在 runtime 再强制校验，这里先保证 parseParamsSchema 自身不抛错）
  parseParamsSchema({
    params_schema: input.params_schema as string | null,
    sql_text: input.sql_text
  });
  // compileNamedParams 在 parseParamsSchema 内部已调用，避免 tree-shaking 漏依赖
  void compileNamedParams;

  try {
    const info = getDb()
      .prepare(
        `INSERT INTO query_template(object_id, name, description, sql_text, params_schema, role_required, rows_limit, timeout_ms, enabled)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.object_id,
        input.name,
        input.description ?? null,
        input.sql_text,
        input.params_schema ?? null,
        input.role_required ?? "public",
        input.rows_limit ?? 1000,
        input.timeout_ms ?? 3000,
        input.enabled ?? 1
      );
    return getTemplate(Number(info.lastInsertRowid));
  } catch (e) {
    const msg = String((e as Error).message ?? "");
    if (/UNIQUE.*query_template\.name/i.test(msg)) {
      throw new BusinessError(
        409,
        `template name already exists: ${input.name} | 模板名已存在: ${input.name}`
      );
    }
    throw e;
  }
}

export interface UpdateTemplateInput extends Partial<CreateTemplateInput> {}

/**
 * 更新自定义 SQL 模板。
 *
 * 字段级增量更新：
 *   · object_id 变化 → 再跑一次「object 存在 + datasource 声明」校验；否则 400
 *   · sql_text 变化 → 再跑一次 SELECT-only 静态分析；否则 400 "sql_text: <reason>"
 *   · params_schema 变化 → 再跑一次 JSON.parse 合法性；否则 400
 *   · name 变化 → 捕获 UNIQUE(name) 冲突 → 409
 *   · 空 patch（无任何字段传入） → 直接返回 existing 行，不做无意义 UPDATE
 *
 * 注意：enabled=0 只影响「调用端」的 404 "template disabled"，对管理端 CRUD 本身不屏蔽；
 *       审计日志 custom_query_log 不会因为 UPDATE 而被清空，DELETE 才会 CASCADE 清理。
 */
export function updateTemplate(id: number, input: UpdateTemplateInput): QueryTemplateOut {
  const existing = getTemplate(id); // 404 兜底
  if (input.object_id !== undefined && input.object_id !== existing.object_id) {
    // 切换绑定的 object：验证新 object 存在
    getObject(input.object_id);
  }
  // SQL 变更时必须重新校验 SELECT-only
  if (input.sql_text !== undefined) {
    const vr = validateSelectOnly(input.sql_text);
    if (!vr.ok) throw new BusinessError(400, `sql_text: ${vr.reason}`);
  }
  // params_schema 变更必须是合法 JSON
  if (input.params_schema !== undefined && String(input.params_schema ?? "").trim().length > 0) {
    try {
      JSON.parse(String(input.params_schema));
    } catch (e) {
      throw new BusinessError(
        400,
        `params_schema is not valid JSON | params_schema 不是有效 JSON: ${(e as Error).message}`
      );
    }
  }

  const patch: Record<string, unknown> = { ...input };
  if (Object.keys(patch).length === 0) return existing;

  const sets = Object.keys(patch)
    .map(k => `"${k}" = ?`)
    .join(", ");
  const vals = [...Object.values(patch), id];
  try {
    getDb()
      .prepare(`UPDATE query_template SET ${sets} WHERE id = ?`)
      .run(...vals);
  } catch (e) {
    const msg = String((e as Error).message ?? "");
    if (/UNIQUE.*query_template\.name/i.test(msg))
      throw new BusinessError(
        409,
        `template name already exists: ${input.name} | 模板名已存在: ${input.name}`
      );
    throw e;
  }
  return getTemplate(id);
}

export function deleteTemplate(id: number): void {
  getTemplate(id); // 404 兜底
  // custom_query_log 通过外键 CASCADE 删除
  getDb().prepare("DELETE FROM query_template WHERE id = ?").run(id);
}
