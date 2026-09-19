/**
 * 通用 CRUD Service —— 任意数据源 + 任意表的动态增删改查。
 *
 * 安全设计：
 *   - 表名：正则白名单校验（isValidIdentifier）+ 引号包裹
 *   - 列名：运行时从数据库元数据发现，白名单校验后才允许进入 SQL
 *   - 值：  全部用 ?  参数化，零 SQL 注入风险
 *   - 过滤：Directus 风格运算符走 utils/filter.ts 内置枚举，列名 schema 白名单
 *   - 聚合：函数名 + 别名 双枚举/正则白名单（见 filter.ts VALID_AGG）
 *
 * 查询语法（参考 Directus REST，部分扩展）：
 *   WHERE 条件（16 种运算符 + AND/OR 分组，见 utils/filter.ts）
 *   fields=id,name,price                    → 选择列（默认 "*"；有聚合时默认空，仅返回聚合列）
 *   groupBy=status,author_id                → GROUP BY
 *   aggregate[count][*]=total_count         → COUNT(*) AS total_count
 *   aggregate[sum][price]=sum_p             → SUM(price) AS sum_p
 *   aggregate[avg][qty]=avg_q               → AVG(qty)   AS avg_q
 *   aggregate[countDistinct][status]=dc     → COUNT(DISTINCT status) AS dc
 *   aggregate[min][price]=min_p & aggregate[max][price]=max_p
 *   orderBy=status:asc,qty:desc             → 多字段排序，每字段可独立指定 asc/desc
 */

import { getDs } from "../datasources/registry.js";
import type { Datasource } from "../datasources/types.js";
import { discoverSchema, quoteId, type TableSchema } from "../utils/schema.js";
import {
  buildFilterFromQuery,
  parseProjection,
  parseGroupBy,
  parseOrderBy,
  extractPrefixed
} from "../utils/filter.js";
import { BusinessError } from "../utils/errors.js";
import { buildJoinSelect, nestJoinedResults, type JoinDesc } from "../utils/join.js";

/**
 * 给 SQL 执行错误挂上 sql + sqlParams，方便 showSql=true 时路由层把调试信息返回前端。
 */
function attachSql(e: unknown, sql: string, params: unknown[]): unknown {
  if (e instanceof Error) {
    (e as Error & { sql?: string; sqlParams?: unknown[] }).sql = sql;
    (e as Error & { sql?: string; sqlParams?: unknown[] }).sqlParams = params;
  }
  return e;
}

/** 包装 ds.query，执行出错时自动把 sql + params 挂到 error 上 */
async function queryWithSql<T extends object = Record<string, unknown>>(
  ds: Datasource,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  try {
    return await ds.query<T>(sql, params);
  } catch (e) {
    throw attachSql(e, sql, params);
  }
}

/** 解析正整数环境变量；缺省/非法（0、负数、小数、非数字）时回退 fallback */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return fallback;
  return n;
}

/**
 * 分页参数（可用 .env 覆盖，缺省/非法回退默认）：
 *   PAGE_SIZE_MAX     —— 单次请求允许的最大每页条数，超出自动截断（默认 500，防一次拖出大表）
 *   PAGE_SIZE_DEFAULT —— 未传 pageSize 时的默认每页条数（默认 20）；保证不超过 PAGE_SIZE_MAX
 */
export const PAGE_SIZE_MAX = parsePositiveInt(process.env.PAGE_SIZE_MAX, 500);
export const PAGE_SIZE_DEFAULT = Math.min(
  parsePositiveInt(process.env.PAGE_SIZE_DEFAULT, 20),
  PAGE_SIZE_MAX
);

/** 保留参数（用作分页/排序/单行开关/列+分组+聚合，不作为 WHERE 过滤字段） */
const RESERVED = new Set([
  "page",
  "pageSize",
  "noPage",
  "nopage", // 向后兼容
  "__one",
  "showSql",
  "orderBy",
  "order",
  "fields",
  "limit",
  "groupBy",
  "having",
  "join"
  // aggregate[*] / having[*] 通过 extractPrefixed 单独拎出来，这里把前缀相关的保留项都处理掉
]);

/**
 * 从 URL query 中把所有 aggregate[...] / having[...] 视作保留，避免 WHERE 解析器把它们当字段。
 * 通过「在解析 WHERE 前把带前缀的 key 临时从 query 中拿掉」实现。
 */
function whereQueryWithoutAggregate(query: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith("aggregate[")) continue;
    if (k.startsWith("having[")) continue;
    if (RESERVED.has(k)) continue;
    // 保留字段过滤运算符：字段[_op] → 交给 buildFilterFromQuery（会检查 key 模式）
    out[k] = v;
  }
  return out;
}

interface ListParams {
  page?: number;
  pageSize?: number;
  nopage?: boolean;
  /** 原始 URL query 字典（不再在路由层筛简单等值） */
  query: Record<string, string>;
  orderByCSV?: string; // 原始 orderBy 值（未解析；支持多字段冒号方向）
  order?: "asc" | "desc";
  /** 关联描述数组（已 validateJoins）；undefined / [] 时不 JOIN */
  joins?: JoinDesc[];
  /**
   * 调试开关：为 true 时在响应中返回完整 SQL 语句（含 ? 参数占位）。
   * 注意：会暴露表名、列名和查询结构，仅建议开发/调试时使用。
   */
  showSql?: boolean;
}

/** 统一列表响应信封（分页 + 不分页共用同一结构） */
export interface ListResponse {
  data: Record<string, unknown>[];
  meta: {
    mode: "paginated" | "nopage";
    /** 仅分页时：总行数（含 HAVING 过滤前的计数；聚合分组时为组数） */
    total?: number;
    /** 仅分页时 */
    page?: number;
    /** 仅分页时 */
    pageSize?: number;
    /** 仅分页时 */
    totalPages?: number;
    /** 仅 nopage 时：返回结果的实际上限 */
    nopageLimit?: number;
  };
  /** 仅当 showSql=true 时返回 */
  sql?: string;
  /** 仅当 showSql=true 时返回 */
  sqlParams?: unknown[];
}

export interface RowResponse {
  data: Record<string, unknown> | null;
  meta: { mode: "row" };
  sql?: string;
  sqlParams?: unknown[];
}

export interface WriteResponse {
  data: Record<string, unknown> | Record<string, unknown>[];
  meta: { mode: "write"; changes: number };
  sql?: string;
  sqlParams?: unknown[];
}

export async function list(
  dsName: string,
  table: string,
  params: ListParams
): Promise<ListResponse> {
  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);
  const dsType = ds.type;
  const tbl = quoteId(table, dsType);
  const query = params.query;

  // —— JOIN 预处理 ——
  const joins = (params.joins ?? []).filter(Boolean);
  const mainAlias = "__m";
  const mainQ = quoteId(mainAlias, dsType);

  // —— 有聚合 / GROUP BY 时忽略 JOIN（避免语义混乱：聚合按主表算，不必 JOIN 膨胀）
  const agg = extractPrefixed(params.query, "aggregate");
  const hasAggregates = Object.keys(agg).length > 0;
  const joinList = hasAggregates ? [] : joins;
  const useJoins = joinList.length > 0;

  // WHERE（基于主表 schema，条件仍为主表字段）—— useJoins 时把 WHERE 列包主表别名去歧义
  const whereQ = whereQueryWithoutAggregate(params.query);
  const { clause, params: whereParams } = buildFilterFromQuery(whereQ, schema, dsType, RESERVED, undefined, joinList);
  let whereSql = "";
  if (clause) {
    whereSql = ` WHERE ${clause}`;
  }

  // GROUP BY / HAVING / ORDER BY（join 时，ORDER BY 的列必须限定在主表）
  const groupCols = parseGroupBy(query.groupBy, schema, dsType);
  const groupSql = groupCols.length > 0 ? ` GROUP BY ${groupCols.join(", ")}` : "";

  // HAVING（有 GROUP BY 或 aggregate 时才生效；列允许引用表字段 + 聚合别名）
  const aggAliases = new Set<string>(Object.values(agg));
  const havingRaw = extractPrefixed(query, "having");
  // 剥掉 having 前缀：having[cnt][_gt] → cnt[_gt]
  const havingQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(havingRaw)) {
    // k = "having[cnt][_gt]" → afterPrefix = "cnt][_gt]" → 把中间的 ][ 替换成 [
    const afterPrefix = k.slice("having[".length).replace("][", "[");
    havingQuery[afterPrefix] = v;
  }
  // HAVING 列名校验允许：表字段 + 聚合别名 + GROUP BY 列
  const havingAllowed = new Set<string>([...schema.columnNames, ...aggAliases, ...groupCols]);
  let havingSql = "";
  let havingParams: unknown[] = [];
  if (Object.keys(havingQuery).length > 0) {
    const havingReserved = new Set<string>(); // HAVING 子条件里没有保留参数
    const { clause, params } = buildFilterFromQuery(havingQuery, schema, dsType, havingReserved, havingAllowed);
    if (clause) {
      havingSql = ` HAVING ${clause}`;
      havingParams = params;
    }
  }

  // 聚合别名集合，允许 ORDER BY 使用 SELECT 中的聚合别名（如 cnt）
  let orderSqlRaw = parseOrderBy(query.orderBy, query.order, schema, dsType, aggAliases, joinList);
  const orderSql = orderSqlRaw ? ` ORDER BY ${orderSqlRaw}` : "";

  // —— 主表 SELECT 列构建 ——
  let fieldsCSV = params.query.fields;
  // 有 GROUP BY 但用户没显式指定 fields → 自动把 GROUP BY 列加入 SELECT
  // （否则 SELECT 里只有聚合列，分组列丢失；SQL 虽合法但前端无意义）
  if (groupCols.length > 0 && !fieldsCSV) {
    fieldsCSV = (query.groupBy ?? "").split(",").map(s => s.trim()).join(",");
  }
  // parseProjection 默认行为复用；若有 joins，不允许 '*'，我们会把 '*' 展开成显式列 + 主表前缀
  const { selectList: rawList, hasAggregates: _ha } = parseProjection(
    fieldsCSV,
    agg,
    schema,
    dsType
  );
  void _ha;

  // 如果有 joins，把主表 SELECT 表达式都包上 `__m."col"` 前缀，并输出 alias 用列名（不含前缀）
  let mainFields: { sql: string; alias: string }[];
  if (useJoins) {
    mainFields = expandMainSelectList(rawList, schema, mainQ, dsType);
  } else {
    // 没 joins 时，直接用 parseProjection 的 sql/alias（sql 中是不带表别名的列名）
    mainFields = rawList.map(s => ({ sql: s.sql, alias: s.alias }));
  }

  // FROM + JOIN 子句（仅 useJoins 时把主表包成 alias __m，加 LEFT JOIN）
  let fromClause: string;
  let selectSql: string;
  if (useJoins) {
    const built = buildJoinSelect(mainAlias, joinList, dsType, mainFields);
    fromClause = ` FROM ${tbl} ${mainQ}${built.joinFromSql}`;
    selectSql = built.fullSelectList.join(", ");
  } else {
    fromClause = ` FROM ${tbl}`;
    selectSql = mainFields.map(f => f.sql).join(", ");
  }
  const baseNoHaving = `${fromClause}${whereSql}${groupSql}`;
  const base = `${baseNoHaving}${havingSql}`;

  // —— 检测是否有 many JOIN（会导致主表行膨胀，分页需特殊处理）——
  const hasManyJoin = joinList.some(j => j.type === "many");

  // —— 分页 total ——
  //   useJoins 时：直接 COUNT(*) 会被 1:N 膨胀，必须 COUNT(DISTINCT 主表主键)
  //   聚合分组时：total = 聚合结果行数
  let total: number;
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? PAGE_SIZE_DEFAULT;

  if (groupSql && havingSql) {
    // 有 HAVING 时：子查询必须包含完整 SELECT（含聚合列）才能执行 HAVING
    const countRows = await queryWithSql<{ cnt: number | string }>(ds,
      `SELECT COUNT(*) AS cnt FROM (SELECT ${selectSql}${base}) AS __aggr_count__`,
      [...whereParams, ...havingParams]
    );
    total = Number(countRows[0]?.cnt ?? 0);
  } else if (groupSql) {
    // 无 HAVING 的 GROUP BY：SELECT 1 足够，只统计分组数
    const countRows = await queryWithSql<{ cnt: number | string }>(ds,
      `SELECT COUNT(*) AS cnt FROM (SELECT 1${baseNoHaving}) AS __aggr_count__`,
      whereParams
    );
    total = Number(countRows[0]?.cnt ?? 0);
  } else if (useJoins && schema.primaryKey) {
    // JOIN 场景 → COUNT(DISTINCT mainPk)
    const pkQ = `${mainQ}.${quoteId(schema.primaryKey, dsType)}`;
    const countRows = await queryWithSql<{ cnt: number | string }>(ds,
      `SELECT COUNT(DISTINCT ${pkQ}) AS cnt FROM ${tbl} ${mainQ}${(() => {
        // 复用 buildJoinSelect，但仅需要 FROM 片段
        const dummy = buildJoinSelect(mainAlias, joinList, dsType, mainFields);
        return dummy.joinFromSql;
      })()}${whereSql}`,
      whereParams
    );
    total = Number(countRows[0]?.cnt ?? 0);
  } else {
    const countRows = await queryWithSql<{ cnt: number | string }>(ds,
      `SELECT COUNT(*) AS cnt FROM ${tbl}${whereSql}`,
      whereParams
    );
    total = Number(countRows[0]?.cnt ?? 0);
  }

  // —— 不分页：直接返回数组，但仍有 LIMIT 防拉爆全表 ——
  if (params.nopage) {
    // nopage 时仍加 LIMIT，默认 PAGE_SIZE_DEFAULT（20），可通过 pageSize 参数显式指定上限
    // 想拉更多 → pageSize 设大（PAGE_SIZE_MAX=500 封顶）；想全量 → 建议改用分页
    const nopageLimit = params.pageSize ?? PAGE_SIZE_DEFAULT;
    const mainSql = `SELECT ${selectSql}${base}${orderSql} LIMIT ?`;
    const mainParams = [...whereParams, ...havingParams, nopageLimit];
    const rows = await queryWithSql<Record<string, unknown>>(ds, mainSql, mainParams);
    const nested = useJoins ? nestJoinedResults(rows, joinList, schema.primaryKey) : rows;
    const result: ListResponse = {
      data: nested,
      meta: { mode: "nopage", nopageLimit }
    };
    if (params.showSql) {
      result.sql = mainSql;
      result.sqlParams = mainParams;
    }
    return result;
  }

  const offset = (page - 1) * pageSize;
  let rows: Record<string, unknown>[];
  let mainSql: string;
  let mainParams: unknown[];

  if (useJoins && hasManyJoin && !groupSql && schema.primaryKey) {
    // —— 1:N JOIN 膨胀 → 两步分页 ——
    //   Step 1: 子查询拿 DISTINCT 主表 pk + ORDER BY + LIMIT/OFFSET
    //   Step 2: 用 pk IN (...) 回查完整 JOIN 数据
    const pkQRaw = quoteId(schema.primaryKey, dsType);
    const pkQ = `${mainQ}.${pkQRaw}`;
    const pkDistinctSql = `SELECT DISTINCT ${pkQ}${base}${orderSql} LIMIT ? OFFSET ?`;
    const pkRows = await queryWithSql<Record<string, unknown>>(
      ds,
      pkDistinctSql,
      [...whereParams, ...havingParams, pageSize, offset]
    );
    const pkValues: Array<number | string> = [];
    for (const r of pkRows) {
      const v = r[schema.primaryKey];
      if (typeof v === "number" || typeof v === "string") pkValues.push(v);
    }
    if (pkValues.length === 0) {
      rows = [];
      mainSql = pkDistinctSql;
      mainParams = [...whereParams, ...havingParams, pageSize, offset];
    } else {
      const pkPh = pkValues.map(() => "?").join(",");
      // 重新拼 WHERE：原 whereSql 可能为空，AND 前要处理
      const extraWhere = `${pkQ} IN (${pkPh})`;
      const combinedWhere = whereSql ? `${whereSql} AND ${extraWhere}` : ` WHERE ${extraWhere}`;
      const orderSqlInner = orderSql ? ` ORDER BY ${orderSqlRaw}` : "";
      mainSql = `SELECT ${selectSql}${fromClause}${combinedWhere}${groupSql}${havingSql}${orderSqlInner}`;
      mainParams = [...whereParams, ...havingParams, ...pkValues];
      rows = await queryWithSql<Record<string, unknown>>(ds, mainSql, mainParams);
    }
  } else {
    mainSql = `SELECT ${selectSql}${base}${orderSql} LIMIT ? OFFSET ?`;
    mainParams = [...whereParams, ...havingParams, pageSize, offset];
    rows = await queryWithSql<Record<string, unknown>>(ds, mainSql, mainParams);
  }
  const nested = useJoins ? nestJoinedResults(rows, joinList, schema.primaryKey) : rows;

  const paginated: ListResponse = {
    data: nested,
    meta: { mode: "paginated", total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 0 }
  };
  if (params.showSql) {
    paginated.sql = mainSql;
    paginated.sqlParams = mainParams;
  }
  return paginated;
}

/**
 * 把 parseProjection 产生的主表 SELECT 列表，在启用 JOIN 时重写为：
 *   · 每项加表别名 `__m."col"` 前缀；
 *   · 通配符 "*" 展开成主表 schema 的全部列（避免输出 MAIN_PREFIX* 这种）；
 *   · 聚合列直接原样保留（caller 保证有 joins 时不会有聚合，见 hasAggregates 置空 joins 逻辑）。
 * 返回的 alias 就是最终列名（buildJoinSelect 再统一加 MAIN_PREFIX 前缀）。
 */
function expandMainSelectList(
  rawList: { sql: string; alias: string }[],
  schema: TableSchema,
  mainTableAliasQ: string,
  dsType: string
): { sql: string; alias: string }[] {
  const out: { sql: string; alias: string }[] = [];
  for (const item of rawList) {
    if (item.alias === "*") {
      // 展开主表所有列 + 主键也包含（显式列顺序按 schema.columns 顺序）
      for (const c of schema.columns) {
        out.push({ sql: `${mainTableAliasQ}.${quoteId(c.name, dsType)}`, alias: c.name });
      }
      continue;
    }
    // 列：item.sql 已经是 quoteId(col)，我们需要把它改成 mainAlias.col；
    // 最简洁方法：直接用 alias（等于列名）重写。parseProjection 对普通列 alias=列名。
    // 对于聚合函数项（item.alias!=列名，schema.columnNames.has 否）—— 保持原样（但 hasAggregates 会让 joins=[]，不会到这里）。
    if (schema.columnNames.has(item.alias)) {
      out.push({ sql: `${mainTableAliasQ}.${quoteId(item.alias, dsType)}`, alias: item.alias });
    } else {
      out.push({ sql: item.sql, alias: item.alias });
    }
  }
  return out;
}

/** 按主键查一行，fieldsCSV 支持列裁剪（空/undefined 等价 SELECT *）。可选 joins。 */
export async function getById(
  dsName: string,
  table: string,
  id: string,
  fieldsCSV?: string,
  joins?: JoinDesc[]
): Promise<Record<string, unknown>> {
  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);
  const pk = schema.primaryKey!;
  const dsType = ds.type;
  const tbl = quoteId(table, dsType);
  const useJoins = Array.isArray(joins) && joins.length > 0;
  const mainAlias = "__m";
  const mainQ = quoteId(mainAlias, dsType);

  const { selectList: rawList } = parseProjection(fieldsCSV, {}, schema, dsType);
  let mainFields = useJoins
    ? expandMainSelectList(rawList, schema, mainQ, dsType)
    : rawList.map(r => ({ sql: r.sql, alias: r.alias }));

  let selectSql: string;
  let fromClause: string;
  if (useJoins) {
    const built = buildJoinSelect(mainAlias, joins!, dsType, mainFields);
    fromClause = ` FROM ${tbl} ${mainQ}${built.joinFromSql}`;
    selectSql = built.fullSelectList.join(", ");
  } else {
    fromClause = ` FROM ${tbl}`;
    selectSql = mainFields.map(f => f.sql).join(", ");
  }
  const whereSql = useJoins
    ? ` WHERE ${mainQ}.${quoteId(pk, dsType)} = ?`
    : ` WHERE ${quoteId(pk, dsType)} = ?`;

  const rows = await queryWithSql<Record<string, unknown>>(ds,
    useJoins
      ? `SELECT ${selectSql}${fromClause}${whereSql}`
      : `SELECT ${selectSql}${fromClause}${whereSql} LIMIT 1`,
    [id]
  );
  if (rows.length === 0) throw new BusinessError(404, `Row not found | 未找到行: ${id}`);
  if (!useJoins) return rows[0];
  const nested = nestJoinedResults(rows, joins!, schema.primaryKey);
  if (nested.length === 0) throw new BusinessError(404, `Row not found | 未找到行: ${id}`);
  return nested[0];
}

/** 按条件查一行（返回第一条匹配；条件仍然使用 Directus 风格 query 解析）；
 *  同时支持 fields=...,fieldsCSV,aggregate[*]（有聚合时默认 LIMIT 1 组）。
 *  有聚合/GROUP BY 时 joins 被忽略。 */
export async function getOne(
  dsName: string,
  table: string,
  query: Record<string, string>,
  joins?: JoinDesc[]
): Promise<Record<string, unknown>> {
  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);
  const dsType = ds.type;
  const tbl = quoteId(table, dsType);
  const mainAlias = "__m";
  const mainQ = quoteId(mainAlias, dsType);

  const whereQ = whereQueryWithoutAggregate(query);

  // 提前算好 aggregate / group / joinsEff，让 buildFilterFromQuery 能感知 JOIN
  const agg = extractPrefixed(query, "aggregate");
  const fieldsCSV = query.fields;
  const hasAggregates = Object.keys(agg).length > 0;
  const groupCols = parseGroupBy(query.groupBy, schema, dsType);
  const joinsEff = hasAggregates || groupCols.length > 0 ? [] : (joins ?? []).filter(Boolean);
  const useJoins = joinsEff.length > 0;

  // 过滤条件：joinsEff 传进去让 renderAtom 正确加表别名前缀
  const { clause, params } = buildFilterFromQuery(whereQ, schema, dsType, RESERVED, undefined, joinsEff);
  if (!clause)
    throw new BusinessError(400, "At least one condition is required | 至少需要一个查询条件");

  const { selectList: rawList } = parseProjection(fieldsCSV, agg, schema, dsType);
  const groupSql = groupCols.length > 0 ? ` GROUP BY ${groupCols.join(", ")}` : "";

  const mainFields = useJoins
    ? expandMainSelectList(rawList, schema, mainQ, dsType)
    : rawList.map(r => ({ sql: r.sql, alias: r.alias }));

  let selectSql: string;
  let fromClause: string;
  let whereSql: string;
  if (useJoins) {
    const built = buildJoinSelect(mainAlias, joinsEff, dsType, mainFields);
    fromClause = ` FROM ${tbl} ${mainQ}${built.joinFromSql}`;
    selectSql = built.fullSelectList.join(", ");
    // buildFilterFromQuery 已在 renderAtom 中正确加了主表/子表别名前缀
    whereSql = ` WHERE ${clause}`;
  } else {
    fromClause = ` FROM ${tbl}`;
    selectSql = mainFields.map(f => f.sql).join(", ");
    whereSql = ` WHERE ${clause}`;
  }

  if (hasAggregates && !groupCols.length) {
    const rows = await queryWithSql<Record<string, unknown>>(ds,
      `SELECT ${selectSql}${fromClause}${whereSql} LIMIT 1`,
      params
    );
    if (rows.length === 0) throw new BusinessError(404, "Row not found | 未找到行");
    return rows[0];
  }
  const rows = await queryWithSql<Record<string, unknown>>(ds,
    useJoins
      ? `SELECT ${selectSql}${fromClause}${whereSql}${groupSql}`
      : `SELECT ${selectSql}${fromClause}${whereSql}${groupSql} LIMIT 1`,
    params
  );
  if (rows.length === 0) throw new BusinessError(404, "Row not found | 未找到行");
  if (!useJoins) return rows[0];
  const nested = nestJoinedResults(rows, joinsEff, schema.primaryKey);
  return nested[0];
}

/**
 * 插入一行（只接受 schema 中存在的列）。
 * 返回完整的新行数据（以数据库实际写入值为准，包括自增主键、UUID 函数、默认值等）。
 *   如果传了 fieldsCSV，则在 SELECT 阶段只选取指定列（schema 白名单校验）。
 *
 * 写入顺序保证：
 *   1. 先调用 parseProjection 对 fieldsCSV 做 schema 白名单校验
 *      → 字段非法直接 400，**INSERT 尚未执行**，不会出现「插入了但返回报错」的半状态
 *   2. 再执行 INSERT → 回查 SELECT（复用已经建好的 selectList）
 */
export async function insertRow(
  dsName: string,
  table: string,
  data: Record<string, unknown>,
  fieldsCSV?: string
): Promise<{ ok: true; row: Record<string, unknown> }> {
  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);
  const pk = schema.primaryKey; // 可能为 null（极少数没主键的表）

  // 列名白名单过滤
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (schema.columnNames.has(k)) filtered[k] = v;
  }
  const keys = Object.keys(filtered);
  if (keys.length === 0)
    throw new BusinessError(400, "No valid columns to insert | 没有可插入的有效列");

  // —— 预先构建回查列（字段非法先报错，INSERT 尚未执行）——
  const { selectList } = parseProjection(fieldsCSV, {}, schema, ds.type);
  const selectSql = selectList.map(s => s.sql).join(", ");

  const tbl = quoteId(table, ds.type);
  const cols = keys.map(k => quoteId(k, ds.type)).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  const result = await ds.run(
    `INSERT INTO ${tbl} (${cols}) VALUES (${placeholders})`,
    Object.values(filtered)
  );

  // —— 定位主键值 ——
  //    优先级：用户传了主键值 → 使用用户值（比如 TEXT PK、自定义 INT）；
  //            否则才用 lastInsertRowid（INTEGER PRIMARY KEY AUTOINCREMENT 的自增值）。
  //    对 TEXT 类型主键，SQLite 仍然会更新全局 last_insert_rowid == rowid（整数），
  //    但它 != TEXT 主键值。如果先拿 lastInsertRowid 就会回查错行。
  let pkValue: unknown = undefined;
  const userProvidedPk = pk !== null ? filtered[pk] : undefined;

  if (userProvidedPk !== undefined) {
    pkValue = userProvidedPk;
  } else if (result.lastInsertRowid && result.lastInsertRowid !== 0) {
    pkValue = Number(result.lastInsertRowid);
  }

  // —— 没有主键的表：直接返回写入列 + lastInsertRowid 兜底 ——
  if (pk === null) {
    return { ok: true, row: { ...filtered, lastInsertRowid: Number(result.lastInsertRowid) } };
  }

  // —— 没有确定主键值：不回查，避免 WHERE pk = NULL 查出意外结果 ——
  if (pkValue === undefined) {
    return { ok: true, row: { ...filtered, [pk]: null as unknown } };
  }

  // —— 回查（fields 允许裁剪输出列；已预构建）——
  const rows = await queryWithSql<Record<string, unknown>>(ds,
    `SELECT ${selectSql} FROM ${tbl} WHERE ${quoteId(pk, ds.type)} = ? LIMIT 1`,
    [pkValue]
  );
  if (rows[0]) return { ok: true, row: rows[0] };
  // 回查失败（少见）：兜底返回写入列 + 主键值
  return { ok: true, row: { ...filtered, [pk]: pkValue } };
}

/**
 * 按主键更新一行（排除主键列本身）。
 * 返回 { ok: true, row }：row 为更新后 SELECT 回查所得新行。
 *   如果传了 fieldsCSV，返回 row 按指定列裁剪。
 *
 * 写入顺序保证：fields 非法先 400，UPDATE 尚未执行。
 */
export async function updateRow(
  dsName: string,
  table: string,
  id: string,
  data: Record<string, unknown>,
  fieldsCSV?: string
): Promise<{ ok: true; row: Record<string, unknown> }> {
  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);
  const pk = schema.primaryKey;
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (schema.columnNames.has(k) && k !== pk) filtered[k] = v;
  }
  const keys = Object.keys(filtered);
  if (keys.length === 0)
    throw new BusinessError(400, "No valid columns to update | 没有可更新的有效列");
  const tbl = quoteId(table, ds.type);

  // —— 预先构建回查列（字段非法先 400，UPDATE 尚未执行）——
  const { selectList } = parseProjection(fieldsCSV, {}, schema, ds.type);
  const selectSql = selectList.map(s => s.sql).join(", ");

  const setClause = keys.map(k => `${quoteId(k, ds.type)} = ?`).join(", ");
  const result = await ds.run(
    `UPDATE ${tbl} SET ${setClause} WHERE ${quoteId(pk ?? "rowid", ds.type)} = ?`,
    [...Object.values(filtered), id]
  );
  if (result.changes === 0) throw new BusinessError(404, `Row not found | 未找到行: ${id}`);

  // 回查新行（有主键按主键查，没主键返回空对象兜底；支持 fields 裁剪）
  let row: Record<string, unknown> = {};
  if (pk) {
    const rows = await queryWithSql<Record<string, unknown>>(ds,
      `SELECT ${selectSql} FROM ${tbl} WHERE ${quoteId(pk, ds.type)} = ? LIMIT 1`,
      [id]
    );
    if (rows[0]) row = rows[0];
  }
  return { ok: true, row };
}

/** 按主键删除一行 */
export async function deleteRow(dsName: string, table: string, id: string): Promise<{ ok: true; deleted: 1 }> {
  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);
  const pk = schema.primaryKey!;
  if (!pk)
    throw new BusinessError(
      400,
      `Table "${table}" has no primary key, cannot delete by id | 表 "${table}" 没有主键，无法按 id 删除`
    );
  const tbl = quoteId(table, ds.type);
  const result = await ds.run(`DELETE FROM ${tbl} WHERE ${quoteId(pk, ds.type)} = ?`, [id]);
  if (result.changes === 0) throw new BusinessError(404, `Row not found | 未找到行: ${id}`);
  return { ok: true, deleted: 1 };
}

/** 单次批量删除最大行数（ids 数量 / filter 命中行数） */
const MAX_DELETE_ROWS = 500;

export interface BatchDeleteByIdsRequest {
  ids: Array<string | number>;
}
export interface BatchDeleteByFilterRequest {
  filter: Record<string, unknown>;
}

/** 批量删除 —— 按主键数组 */
export async function batchDeleteByIds(
  dsName: string,
  table: string,
  body: BatchDeleteByIdsRequest,
  showSql = false
): Promise<{ ok: true; deleted: number; sql?: string; sqlParams?: unknown[] }> {
  const ids = body.ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0)
    throw new BusinessError(400, "ids must be a non-empty array");
  if (ids.length > MAX_DELETE_ROWS)
    throw new BusinessError(400, `ids exceeds limit of ${MAX_DELETE_ROWS}`);

  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);
  const pk = schema.primaryKey!;
  if (!pk) throw new BusinessError(400, `Table "${table}" has no primary key`);
  const tbl = quoteId(table, ds.type);
  const pkQ = quoteId(pk, ds.type);
  const placeholders = ids.map(() => "?").join(",");
  const sql = `DELETE FROM ${tbl} WHERE ${pkQ} IN (${placeholders})`;
  const result = await ds.run(sql, ids);
  const resp: { ok: true; deleted: number; sql?: string; sqlParams?: unknown[] } = {
    ok: true,
    deleted: result.changes
  };
  if (showSql) {
    resp.sql = sql;
    resp.sqlParams = ids;
  }
  return resp;
}

/** 批量删除 —— 按 filter（复用查询的 filter 语法） */
export async function batchDeleteByFilter(
  dsName: string,
  table: string,
  query: Record<string, unknown>,
  showSql = false
): Promise<{ ok: true; deleted: number; sql?: string; sqlParams?: unknown[] }> {
  const filterRaw = query.filter;
  if (!filterRaw || typeof filterRaw !== "object" || Object.keys(filterRaw as object).length === 0)
    throw new BusinessError(400, "filter must be a non-empty object");

  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);
  const tbl = quoteId(table, ds.type);

  // 复用 buildFilterFromQuery —— 先把 filter 转成 bracket key 形式再展开
  const filterQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(filterRaw as object)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      filterQuery[k] = String(v);
    } else if (v && typeof v === "object") {
      // flatten { _eq: 1 } → field[_eq]=1
      for (const [op, val] of Object.entries(v as object)) {
        filterQuery[`${k}[${op}]`] = String(val);
      }
    }
  }
  const { clause: whereClause, params } = buildFilterFromQuery(
    filterQuery,
    schema,
    ds.type,
    RESERVED
  );

  // 先 SELECT COUNT 校验上限 —— 防止误删全表
  const countSql = `SELECT COUNT(*) AS cnt FROM ${tbl} WHERE ${whereClause}`;
  const countRow = await ds.query<{ cnt: number }>(countSql, params);
  const cnt = Number(countRow?.[0]?.cnt ?? 0);
  if (cnt > MAX_DELETE_ROWS)
    throw new BusinessError(
      400,
      `filter matches ${cnt} rows, exceeds limit of ${MAX_DELETE_ROWS}. Add stricter conditions or contact admin.`
    );

  // 空 where 应该被前面的 filter 校验拦住了，这里兜底
  const deleteSql = `DELETE FROM ${tbl}${whereClause ? ` WHERE ${whereClause}` : ""}`;
  const result = await ds.run(deleteSql, params);

  const res: { ok: true; deleted: number; sql?: string; sqlParams?: unknown[] } = {
    ok: true,
    deleted: result.changes
  };
  if (showSql) {
    res.sql = deleteSql;
    res.sqlParams = params;
  }
  return res;
}

/** 批量写操作最大行数 */
const MAX_BATCH_ROWS = 500;

// —————————————————————————————————————————————————
// 批量创建 —— 多行 INSERT，事务保证原子性，回查返回所有新行
// —————————————————————————————————————————————————

export interface BatchCreateRequest {
  rows: Array<Record<string, unknown>>;
}

export async function batchCreate(
  dsName: string,
  table: string,
  body: BatchCreateRequest,
  showSql = false
): Promise<{ ok: true; created: number; rows: Record<string, unknown>[]; sql?: string; sqlParams?: unknown[] }> {
  const rows = body.rows ?? [];
  if (!Array.isArray(rows) || rows.length === 0)
    throw new BusinessError(400, "rows must be a non-empty array");
  if (rows.length > MAX_BATCH_ROWS)
    throw new BusinessError(400, `rows exceeds limit of ${MAX_BATCH_ROWS}`);

  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);

  // 统一列白名单（取所有行的字段交集，确保列顺序一致）
  const columnKeys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (schema.columnNames.has(k)) columnKeys.add(k);
    }
  }
  const cols = Array.from(columnKeys);
  if (cols.length === 0)
    throw new BusinessError(400, "No valid columns to insert | 没有可插入的有效列");

  const tbl = quoteId(table, ds.type);
  const colsSql = cols.map(c => quoteId(c, ds.type)).join(", ");

  // 按统一列顺序构造 values + params
  const allParams: unknown[] = [];
  const valueClauses: string[] = [];
  for (const r of rows) {
    const placeholders: string[] = [];
    for (const c of cols) {
      placeholders.push("?");
      allParams.push(r[c] ?? null);
    }
    valueClauses.push(`(${placeholders.join(",")})`);
  }

  const insertSql = `INSERT INTO ${tbl} (${colsSql}) VALUES ${valueClauses.join(",")}`;

  // 执行 INSERT（better-sqlite3.transaction 自动包 BEGIN/COMMIT）
  let lastInsertRowid: number = 0;
  try {
    await ds.transaction(async () => {
      const result = await ds.run(insertSql, allParams);
      lastInsertRowid = Number(result.lastInsertRowid);
    });
  } catch (e) {
    if (e instanceof Error && (e.message.includes("UNIQUE") || e.message.includes("UNIQUE constraint"))) {
      throw new BusinessError(409, `Unique constraint violated | 唯一约束冲突: ${e.message}`);
    }
    throw e;
  }

  // 回查所有新行
  let newRows: Record<string, unknown>[];
  const pk = schema.primaryKey;

  // 收集所有 INSERT 行的 PK 值（用户显式传的优先；否则从 lastInsertRowid 反推自增值）
  const pkValues = new Set<number | string>();
  for (const r of rows) {
    const v = pk ? (r as Record<string, unknown>)[pk] : undefined;
    if (typeof v === "number" || typeof v === "string") pkValues.add(v);
  }
  if (pk !== null && pkValues.size === 0 && lastInsertRowid > 0) {
    // 自增 INTEGER PRIMARY KEY：lastInsertRowid 是最后一行，反推前 N-1 行
    for (let i = rows.length - 1; i >= 0; i--) {
      pkValues.add(lastInsertRowid - i);
    }
  }

  if (pk !== null && pkValues.size > 0) {
    const pkList = Array.from(pkValues);
    const ph = pkList.map(() => "?").join(",");
    newRows = await queryWithSql<Record<string, unknown>>(ds,
      `SELECT * FROM ${tbl} WHERE ${quoteId(pk, ds.type)} IN (${ph})`,
      pkList
    );
  } else if (pk === null && lastInsertRowid > 0) {
    // 无 PK：用 rowid 反推
    const rowids: number[] = [];
    for (let i = rows.length - 1; i >= 0; i--) rowids.push(lastInsertRowid - i);
    const ph = rowids.map(() => "?").join(",");
    newRows = await queryWithSql<Record<string, unknown>>(ds,
      `SELECT * FROM ${tbl} WHERE rowid IN (${ph})`,
      rowids
    );
  } else {
    // 兜底 —— 返回写入列
    newRows = rows.map(r => {
      const obj: Record<string, unknown> = {};
      for (const c of cols) obj[c] = r[c] ?? null;
      return obj;
    });
  }

  const resp: { ok: true; created: number; rows: Record<string, unknown>[]; sql?: string; sqlParams?: unknown[] } = {
    ok: true,
    created: rows.length,
    rows: newRows
  };
  if (showSql) {
    resp.sql = insertSql;
    resp.sqlParams = allParams;
  }
  return resp;
}

// —————————————————————————————————————————————————
// 批量更新 —— 两种模式：
//   A. 按 ids：POST /batch-update   { rows: [{ id, ...patch }, ...] }
//   B. 按 filter + 统一 patch 数据（语义由 rows[0].id 是否存在区分 — 简化起见只做 A）
// —————————————————————————————————————————————————

export interface BatchUpdateRow {
  id: number | string;
  [key: string]: unknown;
}

export async function batchUpdate(
  dsName: string,
  table: string,
  body: { rows: BatchUpdateRow[] },
  showSql = false
): Promise<{ ok: true; updated: number; rows: Record<string, unknown>[]; sql?: string; sqlParams?: unknown[] }> {
  const rows = body.rows ?? [];
  if (!Array.isArray(rows) || rows.length === 0)
    throw new BusinessError(400, "rows must be a non-empty array");
  if (rows.length > MAX_BATCH_ROWS)
    throw new BusinessError(400, `rows exceeds limit of ${MAX_BATCH_ROWS}`);

  const ds = getDs(dsName);
  const schema = await discoverSchema(ds, table);
  const pk = schema.primaryKey!;
  if (!pk)
    throw new BusinessError(
      400,
      `Table "${table}" has no primary key, cannot batch update by id`
    );

  const tbl = quoteId(table, ds.type);
  const pkQ = quoteId(pk, ds.type);
  const updatedRows: Record<string, unknown>[] = [];
  // showSql 只记录第一条有实际 UPDATE 操作的 SQL 模板（逐行 UPDATE 结构一致）
  let sampleSql: string | undefined;
  let sampleParams: unknown[] | undefined;

  try {
    await ds.transaction(async () => {
      let totalChanges = 0;
      for (const r of rows) {
        const { id, ...patch } = r;
        // 列白名单（排除 pk）
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (schema.columnNames.has(k) && k !== pk) filtered[k] = v;
        }
        const keys = Object.keys(filtered);
        if (keys.length === 0) {
          // 跳过空 patch —— 仍然回查当前行
          const [row] = await queryWithSql<Record<string, unknown>>(ds,
            `SELECT * FROM ${tbl} WHERE ${pkQ} = ? LIMIT 1`,
            [id]
          );
          if (row) updatedRows.push(row);
          continue;
        }
        const setClause = keys.map(k => `${quoteId(k, ds.type)} = ?`).join(", ");
        const sql = `UPDATE ${tbl} SET ${setClause} WHERE ${pkQ} = ?`;
        const params = [...Object.values(filtered), id];
        if (showSql && !sampleSql) {
          sampleSql = sql;
          sampleParams = params;
        }
        const result = await ds.run(sql, params);
        totalChanges += result.changes;
        if (result.changes === 0) {
          throw new BusinessError(404, `Row not found: ${id}`);
        }
        // 回查
        const [row] = await queryWithSql<Record<string, unknown>>(ds,
          `SELECT * FROM ${tbl} WHERE ${pkQ} = ? LIMIT 1`,
          [id]
        );
        if (row) updatedRows.push(row);
      }
      // 全部处理完（事务自动 commit）
    });
  } catch (e) {
    // 事务会自动回滚 —— 但需要把内部的 BusinessError 原样抛出
    throw e;
  }

  const resp: { ok: true; updated: number; rows: Record<string, unknown>[]; sql?: string; sqlParams?: unknown[] } = {
    ok: true,
    updated: rows.length,
    rows: updatedRows
  };
  if (showSql && sampleSql) {
    resp.sql = sampleSql;
    resp.sqlParams = sampleParams;
  }
  return resp;
}
