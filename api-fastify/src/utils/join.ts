/**
 * 通用查询关联（JOIN）工具：
 *   - 解析前端 URL 参数 `join=users:one:author,comments:many` 为结构化 JoinDesc[]
 *   - 渲染 SQL LEFT JOIN 片段 + 把 SELECT 列按「别名前缀」导出（__j0$col）
 *   - 从扁平行（SQL JOIN 笛卡尔结果）按主表主键归并，组装出嵌套对象 / 对象数组。
 *
 * 约定优先（Directus 风格）：
 *   单项语法（逗号分隔多项）：
 *     <table>[:<type>][:<as>][:<onCol>]
 *       table  —— 关联的子表名（在同 object/ds 下）
 *       type   —— one | many （可省略；省略时按 FK 推断：主表有 singular(table)_id → one；否则子表有 singular(mainTable)_id → many）
 *       as     —— 输出嵌套字段别名（默认=table，many 时自动复数化：s/x/ch/sh→+es 其余→+s）
 *       onCol  —— 外键列（可省略）
 *                  one  时：onCol 是主表列名，指向子表主键（默认 singular(table)_id）
 *                  many 时：onCol 是子表列名，指向主表主键（默认 singular(mainTable)_id）
 *
 *   示例：posts（主表）join=users,comments → 等价 join=users:one:users:user_id,comments:many:commentses:post_id
 */

import type { TableSchema } from "./schema.js";
import { isValidIdentifier, quoteId } from "./schema.js";
import { BusinessError } from "./errors.js";

/** 单个关联描述 */
export interface JoinDesc {
  /** 子表名（与主表同数据源） */
  table: string;
  /** one = 1:1（嵌套对象或 null）；many = 1:N（嵌套对象数组，空时 []） */
  type: "one" | "many";
  /** SQL JOIN 类型：left（默认，主表全部保留）/ inner（只保留两边都匹配的行） */
  joinType?: "left" | "inner";
  /** 输出 JSON 中的字段别名（如 "author" / "comments"） */
  as: string;
  /**
   * 外键连接条件：
   *   one  ：local = 主表列名，foreign = 子表列名
   *   many ：local = 主表列名（通常主键），foreign = 子表列名
   */
  on: { local: string; foreign: string };
  /**
   * 子表 schema（在路由层校验 join 表白名单时同步 discover）；
   * 必须由调用方在 parseJoinQuery 之后填充，否则 buildJoinSelect 会报 500。
   */
  schema?: TableSchema;
}

/** 结果前缀（必须是合法标识符，方便后续按前缀拆分） */
export const MAIN_PREFIX = "__m$";
export function joinPrefix(idx: number): string {
  return `__j${idx}$`;
}

/** JOIN 场景主表别名（SQL FROM 中使用） */
export const MAIN_TABLE_ALIAS = "__m";
/** JOIN 场景子表别名前缀（SQL FROM/JOIN 中使用；完整别名是 __j_0, __j_1, ...） */
export function joinTableAlias(idx: number): string {
  return `__j_${idx}`;
}

/** 简单词尾复数化：-s/-x/-ch/-sh 加 es；其余加 s（仅英文表名，中文罕见场景兜底 table+s） */
function pluralize(t: string): string {
  if (!t) return t;
  if (/(s|x|ch|sh)$/i.test(t)) return `${t}es`;
  return `${t}s`;
}

/** 把表名拆成「单数」（去掉末尾 s/es 粗略估计，仅用于 many 默认外键推断） */
function singularize(t: string): string {
  if (t.endsWith("ses") || t.endsWith("xes") || t.endsWith("ches") || t.endsWith("shes"))
    return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/**
 * 解析 join 查询参数为 JoinDesc[]（纯解析，不查 schema / 不做权限校验）。
 * 路由层拿到 desc 后，必须再逐张表：
 *   1) resolveObjectAccess(object, desc.table, "select", ctx) 做权限 & 白名单；
 *   2) discoverSchema(ds, desc.table) 填 schema。
 */
export function parseJoinQuery(
  rawJoin: string | undefined,
  mainTable: string,
  mainSchema: TableSchema
): JoinDesc[] {
  if (!rawJoin) return [];
  const trimmed = rawJoin.trim();
  if (!trimmed) return [];

  const terms = trimmed
    .split(",")
    .map(t => t.trim())
    .filter(x => x.length > 0);

  const result: JoinDesc[] = [];
  const usedAs = new Set<string>();
  // 输出别名「as」不能与主表列名冲突（否则前端取数混乱）
  const reservedAs = new Set(mainSchema.columnNames);

  for (const term of terms) {
    const parts = term.split(":");
    const [table, typeRaw, asRaw, onColRaw, joinTypeRaw] = parts;

    if (!table || !isValidIdentifier(table))
      throw new BusinessError(
        400,
        `join: invalid table name in term | join 项中的表名无效 "${term}"`
      );

    // type 校验（可省略）
    let type: "one" | "many" | undefined;
    if (typeRaw !== undefined) {
      if (typeRaw !== "one" && typeRaw !== "many")
        throw new BusinessError(
          400,
          `join: invalid type | join 类型无效 "${typeRaw}" (expected "one" or "many") in term "${term}"`
        );
      type = typeRaw;
    }

    // joinType 校验（可省略，默认 left）
    let joinType: "left" | "inner" | undefined;
    if (joinTypeRaw && joinTypeRaw.length > 0) {
      const jtl = joinTypeRaw.toLowerCase();
      if (jtl !== "left" && jtl !== "inner")
        throw new BusinessError(
          400,
          `join: invalid joinType | join SQL 类型无效 "${joinTypeRaw}" (expected "left" or "inner") in term "${term}"`
        );
      joinType = jtl;
    }

    // 推断 one / many（若省略）：
    //   主表有 <singular(table)>_id 列（如 users→user_id）→ 视作 1:1 one
    //   否则视作 many（子表列指向主表 PK，在 build 时用外键名）
    const autoOneFk = `${singularize(table)}_id`;
    if (!type) type = mainSchema.columnNames.has(autoOneFk) ? "one" : "many";

    // as（别名）：默认 one=table，many=复数化 table
    let as = asRaw && asRaw.length > 0 ? asRaw : type === "many" ? pluralize(table) : table;
    if (!isValidIdentifier(as))
      throw new BusinessError(400, `join: invalid alias | join 别名无效 "${as}" in term "${term}"`);
    if (reservedAs.has(as))
      throw new BusinessError(
        400,
        `join: alias "${as}" conflicts with a column of "${mainTable}". Pick a different alias via join=${table}:${type}:<different_name>`
      );
    if (usedAs.has(as))
      throw new BusinessError(
        400,
        `join: duplicate alias | join 别名重复 "${as}" (use explicit :as 区分）`
      );
    usedAs.add(as);

    // onCol（外键列）—— 支持两种格式：
    //   单名 "user_id"        → 自动推断另一端（one→子表PK, many→主表PK）
    //   双向 "user_id=id"     → local=foreign，完全显式
    let onCol: string | undefined;
    let onOverride: { local: string; foreign: string } | undefined;
    if (onColRaw && onColRaw.length > 0) {
      const eqIdx = onColRaw.indexOf("=");
      if (eqIdx > 0) {
        // 双向："localCol=foreignCol"
        const local = onColRaw.slice(0, eqIdx).trim();
        const foreign = onColRaw.slice(eqIdx + 1).trim();
        if (!isValidIdentifier(local) || !isValidIdentifier(foreign))
          throw new BusinessError(
            400,
            `join: invalid on local or foreign column | join on 列无效 "${onColRaw}" in term "${term}"`
          );
        onOverride = { local, foreign };
        onCol = local; // 保留 onCol 用于后续类型推断的基础
      } else {
        onCol = onColRaw;
        if (!isValidIdentifier(onCol))
          throw new BusinessError(
            400,
            `join: invalid column | join 列无效 "${onCol}" in term "${term}"`
          );
      }
    }

    // —— 推断 one / many & 默认 onCol（若省略） ——
    let autoType: "one" | "many";
    if (!type) {
      type = mainSchema.columnNames.has(autoOneFk) ? "one" : "many";
      autoType = type;
    } else {
      autoType = type;
    }

    // 默认 onCol（若省略且无双向覆盖）
    if (!onCol && !onOverride) {
      if (autoType === "one")
        onCol = `${singularize(table)}_id`; // 单数前缀：users→user_id
      else onCol = `${singularize(mainTable)}_id`;
    }
    if (!onCol) onCol = ""; // 兜底，不会到这里

    let on: { local: string; foreign: string };
    if (onOverride) {
      // 双向显式：跳过类型推断，直接用用户指定的两端
      on = onOverride;
    } else if (autoType === "one") {
      if (!mainSchema.columnNames.has(onCol))
        throw new BusinessError(
          400,
          `join(one "${table}"): expected local FK column "${onCol}" on "${mainTable}", column not found`
        );
      on = { local: onCol, foreign: "__PK__" };
    } else {
      if (!mainSchema.primaryKey)
        throw new BusinessError(
          400,
          `join(many "${table}"): main table "${mainTable}" has no primary key, cannot join as many`
        );
      on = { local: mainSchema.primaryKey, foreign: onCol };
    }

    result.push({ table, type, joinType, as, on });
  }
  return result;
}

/**
 * 发现完子表 schema 之后，把 JoinDesc.on.foreign 占位 "__PK__" 替换为真实子表主键；
 * 同时校验 one/many 各自的外键列确实存在。
 * 调用顺序：parseJoinQuery → [逐张表：resolveObjectAccess + discoverSchema] → validateJoins()
 */
export function validateJoins(joins: JoinDesc[]): void {
  for (const j of joins) {
    if (!j.schema)
      throw new BusinessError(500, `join "${j.table}" schema not resolved (internal error)`);
    if (j.type === "one") {
      if (j.on.foreign !== "__PK__") continue; // 已手动填（扩展点）
      if (!j.schema.primaryKey)
        throw new BusinessError(
          400,
          `join(one "${j.table}"): target table has no primary key, cannot infer FK target`
        );
      j.on.foreign = j.schema.primaryKey;
      // 子表 foreign（PK）存在性由 discoverSchema 保证；无需再次校验
    } else {
      // many：子表列 j.on.foreign 必须存在
      if (!j.schema.columnNames.has(j.on.foreign))
        throw new BusinessError(
          400,
          `join(many "${j.table}"): expected foreign column "${j.on.foreign}" on "${j.table}", column not found`
        );
    }
  }
}

/**
 * 构建 join 相关的 SQL 片段与 SELECT 输出。
 *
 * @param mainTableAlias 主表别名（查询里固定 "__m"）
 * @param joins   已 validateJoins 完成的关联数组
 * @param dsType  数据源类型（sqlite/mysql）决定 quote
 * @param mainFieldsSql 主表 SELECT 列（SQL 表达式，已引用 mainTableAlias）
 * @returns
 *   joinFromSql   : LEFT JOIN ... 片段（拼到主表 FROM 后）
 *   fullSelectList: 完整 SELECT 表达式列表（含前缀化的主表列 + 每个 join 的列）
 */
export function buildJoinSelect(
  mainTableAlias: string,
  joins: JoinDesc[],
  dsType: string,
  mainFieldsSql: { sql: string; alias: string }[]
): {
  joinFromSql: string;
  fullSelectList: string[];
} {
  const MAIN = quoteId(mainTableAlias, dsType);
  // 主表列全部重命名为 MAIN_PREFIX
  const fullSelect: string[] = mainFieldsSql.map(f => {
    if (f.alias === "*") {
      // 主表 * → 展开主表所有列 + 前缀映射
      // 但我们这里没有展开 schema 列；调用方禁止把 "*" 直接传入，必须事先展开为 schema.columns 逐项。
      throw new BusinessError(
        500,
        "buildJoinSelect received wildcard '*' instead of expanded columns"
      );
    }
    // f.sql 形如 "mainAlias"."col" 或聚合表达式。约定传入的 mainFieldsSql 每项 sql 已经写 `MAIN."col"`。
    return `${f.sql} AS ${quoteId(`${MAIN_PREFIX}${f.alias}`, dsType)}`;
  });

  let joinFromSql = "";
  for (let i = 0; i < joins.length; i++) {
    const j = joins[i];
    const prefix = joinPrefix(i);
    const JT = quoteId(`__j_${i}`, dsType);
    const tQ = quoteId(j.table, dsType);
    const localCol = quoteId(j.on.local, dsType);
    const foreignCol = quoteId(j.on.foreign, dsType);
    const joinKw = j.joinType === "inner" ? "INNER JOIN" : "LEFT JOIN";
    joinFromSql += ` ${joinKw} ${tQ} ${JT} ON ${MAIN}.${localCol} = ${JT}.${foreignCol}`;
    if (!j.schema)
      throw new BusinessError(500, `join "${j.table}" schema missing (validateJoins not called?)`);
    for (const col of j.schema.columns) {
      fullSelect.push(
        `${JT}.${quoteId(col.name, dsType)} AS ${quoteId(`${prefix}${col.name}`, dsType)}`
      );
    }
  }

  return { joinFromSql, fullSelectList: fullSelect };
}

/**
 * 将 buildJoinSelect 产生的「前缀化」扁平行数组，还原为主行的嵌套对象结构。
 *   - one：如果前缀 j0 所有列均 NULL → 挂 null；否则挂子对象（列名去前缀）
 *   - many：同一主 PK 下，子对象去重后 push 到数组（不会重复同一子行）
 *
 * 重要：caller 必须保证主表 primaryKey 列被包含在 mainFieldsSql 里（否则无法识别「同一主行」）。
 * 如果主表没主键，many 关联会退回「每行一条」（1:N 场景主表必含 PK，SQLite 默认 rowid，但这里用显式 PK）。
 */
export function nestJoinedResults(
  rows: Record<string, unknown>[],
  joins: JoinDesc[],
  mainPk: string | null
): Record<string, unknown>[] {
  if (joins.length === 0) return rows; // 未关联，原样返回（没有任何前缀，原 rows 已是 __m$... 不成立，此分支仅「caller 没传 joins」路径）

  const buckets = new Map<string, Record<string, unknown>>();
  const bucketOrder: string[] = [];

  for (const flat of rows) {
    // 1) 先拆主行（key=MAIN_PREFIX+col → value）
    const mainRow: Record<string, unknown> = {};
    let pkValue: string | null = null;
    for (const [k, v] of Object.entries(flat)) {
      if (!k.startsWith(MAIN_PREFIX)) continue;
      const col = k.slice(MAIN_PREFIX.length);
      mainRow[col] = v;
      if (mainPk && col === mainPk) pkValue = String(v ?? "__NULL__");
    }
    // 没 PK（极端场景，主键未 SELECT 或表无 PK）：用 JSON 串整行当去重 key（仅 one 可用，many 会乱）
    let key = pkValue;
    if (!key) key = JSON.stringify(mainRow);

    // 2) 取 / 初始化 bucket
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = mainRow;
      // 为每个 many 关联先初始化空数组（避免「0 条子对象时 undefined」，约定显式 []）
      for (const j of joins) {
        if (j.type === "many") bucket[j.as] = [];
        else bucket[j.as] = null; // one 初始 null
      }
      buckets.set(key, bucket);
      bucketOrder.push(key);
    }

    // 3) 拆每个 join 的子对象
    for (let i = 0; i < joins.length; i++) {
      const j = joins[i];
      const pfx = joinPrefix(i);
      const child: Record<string, unknown> = {};
      let allNull = true;
      for (const [k, v] of Object.entries(flat)) {
        if (!k.startsWith(pfx)) continue;
        const col = k.slice(pfx.length);
        child[col] = v;
        if (v !== null && v !== undefined) allNull = false;
      }
      if (allNull) continue; // LEFT JOIN 没匹配到子行 → one 保持 null / many 不 push

      if (j.type === "one") {
        (bucket as Record<string, unknown>)[j.as] = child;
      } else {
        const arr = (bucket as Record<string, unknown>)[j.as] as Record<string, unknown>[];
        // 子行去重（同主行 + 同子 PK 同一对象只加一次；无 PK 则用整个子对象 JSON）
        const cpk = j.schema?.primaryKey;
        const ckey =
          cpk && child[cpk] !== undefined && child[cpk] !== null
            ? String(child[cpk])
            : JSON.stringify(child);
        const seen =
          (bucket as Record<string, Set<string>>)[`__seen_${j.as}_`] ?? new Set<string>();
        if (!seen.has(ckey)) {
          seen.add(ckey);
          (bucket as Record<string, unknown>)[`__seen_${j.as}_`] = seen;
          arr.push(child);
        }
      }
    }
  }

  // 4) 清理桶内临时 __seen_xxx_ 字段
  for (const key of bucketOrder) {
    const bucket = buckets.get(key)!;
    for (const j of joins) {
      if (j.type !== "many") continue;
      delete bucket[`__seen_${j.as}_`];
    }
  }
  return bucketOrder.map(k => buckets.get(k)!);
}
