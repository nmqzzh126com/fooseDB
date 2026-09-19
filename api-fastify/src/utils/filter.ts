/**
 * Directus 风格的通用查询解析器。
 *
 * 三部分输出：
 *   1. WHERE 条件（buildFilterFromQuery，已实现，见下）
 *   2. SELECT 列 + 聚合函数表达式（parseProjection）
 *   3. GROUP BY + ORDER BY 字段列表白名单解析
 *
 * 安全：所有列名、聚合函数、别名都走 schema 白名单 / 枚举校验，绝不拼注入字符。
 */

import { BusinessError } from "./errors.js";
import type { TableSchema } from "./schema.js";
import { quoteId } from "./schema.js";
import type { JoinDesc } from "./join.js";
import { MAIN_TABLE_ALIAS, joinTableAlias } from "./join.js";

type FilterOp =
  | "_eq"
  | "_neq"
  | "_lt"
  | "_lte"
  | "_gt"
  | "_gte"
  | "_like"
  | "_nlike"
  | "_contains"
  | "_starts_with"
  | "_ends_with"
  | "_in"
  | "_nin"
  | "_null"
  | "_nnull"
  | "_not_null"
  | "_between";

/** 合法运算符集合（哈希表 O(1) 校验） */
const VALID_OPS: Record<FilterOp, true> = {
  _eq: true,
  _neq: true,
  _lt: true,
  _lte: true,
  _gt: true,
  _gte: true,
  _like: true,
  _nlike: true,
  _contains: true,
  _starts_with: true,
  _ends_with: true,
  _in: true,
  _nin: true,
  _null: true,
  _nnull: true,
  _not_null: true,
  _between: true
} as const;

/** IN 参数最大数量（防超长 IN (...) 语句） */
const MAX_IN_ITEMS = 500;

/** 单个原子过滤条件 */
interface AtomCondition {
  field: string;
  op: FilterOp;
  /** 原始查询字符串值；多值用逗号分隔（IN / BETWEEN） */
  rawValue: string;
}

/** 解析结果：AND/OR 组合成的条件树 */
type FilterAst =
  | { kind: "atom"; atom: AtomCondition }
  | { kind: "and"; children: FilterAst[] }
  | { kind: "or"; children: FilterAst[] };

/**
 * 将单个 URL key=value 对拆为 [field, op]。
 * 支持的 key 形态：
 *   "name"            → { field: "name", op: "_eq" }
 *   "name[_eq]"       → { field: "name", op: "_eq" }
 *   "age[_gt]"        → { field: "age",  op: "_gt" }
 *   "tags[_in]"       → { field: "tags", op: "_in" }
 */
function parseFilterKey(key: string): { field: string; op: FilterOp } | null {
  const m = key.match(/^([^[\]]+)(?:\[_([a-z_]+)\])?$/);
  if (!m) return null;
  const field = m[1];
  const op = (m[2] ? `_${m[2]}` : "_eq") as FilterOp;
  if (!VALID_OPS[op]) return null;
  return { field, op };
}

/**
 * 从扁平 query 字典提取过滤条件（排除保留参数）。
 * 返回过滤 AST，按字段分组后默认 AND 连接；[_or] 分组单独处理。
 *
 * 注：[_and] 目前显式实现为「默认 AND」的同义写法，可在前端按需声明。
 */
/**
 * 按顶层 bracket 配对拆分路径。
 * 关键：field 内部可以再带 bracket（如 "name[_like]"），解析器按配对层级跳过内部 bracket。
 *
 *   "_or[0][product_name[_like]]" → ["_or", 0, "product_name[_like]"]
 *   "_or[0][product_name][_like]" → ["_or", 0, "product_name", "_like"]
 *   "product_count[_gt]"          → ["product_count[_gt]"]
 */
function parseBracketPath(key: string): (string | number)[] {
  const result: (string | number)[] = [];
  let i = 0;
  while (i < key.length) {
    // 读一段非 bracket 的前缀
    let j = i;
    while (j < key.length && key[j] !== "[") j++;
    if (j > i) result.push(key.slice(i, j));
    i = j;
    if (i >= key.length) break;
    // 进入一个 [，找到配对的 ]（跳过内部嵌套）
    let depth = 1;
    let k = i + 1;
    while (k < key.length && depth > 0) {
      if (key[k] === "[") depth++;
      else if (key[k] === "]") depth--;
      if (depth === 0) break;
      k++;
    }
    const segment = key.slice(i + 1, k);
    result.push(/^\d+$/.test(segment) ? Number(segment) : segment);
    i = k + 1;
  }
  return result;
}

/**
 * 递归过滤器组 Map。
 * 每层默认 AND 连接；_or 子组彼此 OR，_and 子组彼此 AND。
 */
interface GroupMap {
  atoms?: AtomCondition[];
  _or?: Map<number, GroupMap>;
  _and?: Map<number, GroupMap>;
}

/** 确保 GroupMap 上有 atoms 数组 */
function ensureAtoms(g: GroupMap): AtomCondition[] {
  if (!g.atoms) g.atoms = [];
  return g.atoms;
}
/** 确保 GroupMap 上有 _or map */
function ensureOr(g: GroupMap): Map<number, GroupMap> {
  if (!g._or) g._or = new Map();
  return g._or;
}
/** 确保 GroupMap 上有 _and map */
function ensureAnd(g: GroupMap): Map<number, GroupMap> {
  if (!g._and) g._and = new Map();
  return g._and;
}

/**
 * 把一条 (bracketPath, rawValue) 插入到根 GroupMap。
 * bracketPath 形如 ["_or", 0, "product_name", "_like"]
 *                      ↑ path[0]              ↑ path[last]
 */
function insertIntoGroup(
  group: GroupMap,
  path: (string | number)[],
  rawValue: string
): void {
  if (path.length === 0) {
    throw new BusinessError(400, `Empty filter key path | 过滤键路径为空`);
  }

  // 顶层快捷：path 首段不是 _or/_and —— 直接是 atom
  if (path[0] !== "_or" && path[0] !== "_and") {
    // 正确拼成 field 字符串：
    //   ["name", "_eq"]        → "name[_eq]"
    //   ["product_count[_gt]"] → "product_count[_gt]"
    let fieldStr = "";
    for (let i = 0; i < path.length; i++) {
      fieldStr += i === 0 ? String(path[i]) : `[${path[i]}]`;
    }
    const parsed = parseFilterKey(fieldStr);
    if (!parsed) {
      throw new BusinessError(
        400,
        `Invalid filter key: ${fieldStr} | 无效过滤键: ${fieldStr}`
      );
    }
    ensureAtoms(group).push({ ...parsed, rawValue });
    return;
  }

  // 嵌套组：path[0] = "_or" 或 "_and"
  if (path.length < 2 || typeof path[1] !== "number") {
    throw new BusinessError(
      400,
      `Filter key "${path[0]}" requires an index | ${path[0]} 需要索引`
    );
  }
  const kind = path[0];
  const idx = path[1];
  const rest = path.slice(2);

  const subMap = kind === "_or" ? ensureOr(group) : ensureAnd(group);
  let sub = subMap.get(idx);
  if (!sub) {
    sub = {};
    subMap.set(idx, sub);
  }

  if (rest.length === 0) {
    throw new BusinessError(
      400,
      `Empty filter group: ${kind}[${idx}] | 空的过滤组`
    );
  }
  insertIntoGroup(sub, rest, rawValue);
}

/**
 * 递归把 GroupMap 转成 FilterAst。
 *
 * 每层 GroupMap 的语义：
 *   - atoms 之间 → AND
 *   - _or[idx] 子组 → 彼此 OR
 *   - _and[idx] 子组 → 彼此 AND
 *
 * 生成的 FilterAst：
 *   取 atoms 的 atom nodes + 所有 _and[idx] 的递归结果 +
 *   把所有 _or[idx] 的递归结果包成一个 OR node
 *   → 所有 children 之间 AND（如果只有一个直接返回，否则包 AND）
 */
function groupMapToAst(group: GroupMap): FilterAst | null {
  const children: FilterAst[] = [];

  // 1. atoms
  if (group.atoms && group.atoms.length > 0) {
    for (const a of group.atoms) {
      children.push({ kind: "atom", atom: a });
    }
  }

  // 2. _and[idx] 子组（彼此 AND）
  if (group._and) {
    const indices = [...group._and.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const subAst = groupMapToAst(group._and.get(idx)!);
      if (subAst) children.push(subAst);
    }
  }

  // 3. _or[idx] 子组（彼此 OR → 包成一个 OR node）
  if (group._or) {
    const indices = [...group._or.keys()].sort((a, b) => a - b);
    const orChildren: FilterAst[] = [];
    for (const idx of indices) {
      const subAst = groupMapToAst(group._or.get(idx)!);
      if (subAst) orChildren.push(subAst);
    }
    if (orChildren.length === 1) {
      children.push(orChildren[0]);
    } else if (orChildren.length > 1) {
      children.push({ kind: "or", children: orChildren });
    }
  }

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { kind: "and", children };
}

/**
 * 从 URL query 字典构建 WHERE 条件 AST（支持任意深度的 _or/_and 嵌套）。
 *
 * URL 语法：
 *   顶层默认 AND：
 *     product_count[_gt]=10
 *     pt.flag[_eq]=0
 *
 *   第一层 OR：_or[idx] 内部默认 AND
 *     _or[0][product_name[_like]]=%机%
 *     _or[0][product_count[_gt]]=5        ← _or[0] = AND(name LIKE, count > 5)
 *     _or[1][pt.type_name[_like]]=%笔记本%
 *
 *   嵌套 OR 在 OR 里：
 *     _or[0][_or][0][a][_eq]=1
 *     _or[0][_or][1][b][_eq]=2            ← _or[0] = OR(a=1, b=2)
 *
 *   嵌套 AND 在 OR 里：
 *     _or[0][_and][0][a][_eq]=1
 *     _or[0][_and][1][b][_eq]=2           ← _or[0] = AND(a=1, b=2)
 *
 *   完全嵌套示例：
 *     _or[0][_and][0][a[_eq]]=1
 *     _or[0][_or][0][b[_eq]]=2
 *     _or[0][_or][1][c[_eq]]=3
 *     _or[1][d[_eq]]=4
 *     → WHERE (a=1 AND (b=2 OR c=3)) OR d=4
 */
export function parseFiltersFromQuery(
  query: Record<string, string>,
  reserved: Set<string>
): FilterAst | null {
  const root: GroupMap = {};

  for (const [k, rawValue] of Object.entries(query)) {
    if (reserved.has(k)) continue;

    // 跳过那些永远不是过滤器的键
    if (k === "_or" || k === "_and") {
      throw new BusinessError(
        400,
        `Invalid filter key: "${k}" (missing index). Use ${k}[0][...] syntax | 缺少索引`
      );
    }
    if (k.startsWith("_or[") || k.startsWith("_and[")) {
      // 嵌套键 —— bracket path 解析
      const path = parseBracketPath(k);
      insertIntoGroup(root, path, rawValue);
      continue;
    }

    // 普通原子键
    const parsed = parseFilterKey(k);
    if (!parsed) {
      throw new BusinessError(
        400,
        `Invalid filter key: ${k} | 无效过滤键: ${k}`
      );
    }
    ensureAtoms(root).push({ ...parsed, rawValue });
  }

  return groupMapToAst(root);
}

/** 单个原子条件 → {clause: string, params: unknown[]} */
function renderAtom(
  atom: AtomCondition,
  schema: TableSchema,
  dsType: string,
  extraAllowedColumns?: Set<string>,
  joins?: JoinDesc[]
): { clause: string; params: unknown[] } {
  let { field, op, rawValue } = atom;
  let qualifiedCol: string; // 最终 SQL 中的列引用（含表前缀）

  // —— 子表列识别：field 含 "." → <as>.<col> 或 <table>.<col> ——
  //   例：product_type.name[_like]=台   → as=product_type, col=name
  //   例：pt.name[_eq]=台式机            → as=pt, col=name
  //   例：comments.body[_contains]=hello → table=comments, col=body
  const dotIdx = field.indexOf(".");
  if (dotIdx > 0) {
    const prefix = field.slice(0, dotIdx);
    const subField = field.slice(dotIdx + 1);
    if (!joins || joins.length === 0) {
      throw new BusinessError(
        400,
        `Sub-table column in filter but no joins: ${field} | 过滤器使用了子表列但没有 JOIN: ${field}`
      );
    }
    // 先按 as 匹配（用户显式别名），再按 table 匹配
    const joinIdx = joins.findIndex(j => j.as === prefix || j.table === prefix);
    if (joinIdx < 0) {
      throw new BusinessError(
        400,
        `Unknown join prefix "${prefix}" in filter: ${field} | 过滤条件中 join 前缀未知 "${prefix}": ${field}`
      );
    }
    const join = joins[joinIdx];
    if (!join.schema) {
      throw new BusinessError(
        400,
        `Join "${join.table}" has no schema resolved, cannot filter by its columns`
      );
    }
    if (!join.schema.columnNames.has(subField)) {
      throw new BusinessError(
        400,
        `Unknown column "${subField}" in join "${prefix}" | 子表 "${prefix}" 中列未知: ${subField}`
      );
    }
    // 用表别名前缀："__j_0"."col" 或 "__m"."col"
    qualifiedCol = `${quoteId(joinTableAlias(joinIdx), dsType)}.${quoteId(subField, dsType)}`;
  } else {
    // 主表列（无 "."）
    const allowed = extraAllowedColumns?.has(field) ?? false;
    if (!allowed && !schema.columnNames.has(field)) {
      throw new BusinessError(
        400,
        `Unknown column in filter: ${field} | 过滤条件中的列未知: ${field}`
      );
    }
    // 有 JOIN 时主表列也需要限定表别名前缀
    qualifiedCol = joins && joins.length > 0
      ? `${quoteId(MAIN_TABLE_ALIAS, dsType)}.${quoteId(field, dsType)}`
      : quoteId(field, dsType);
  }

  // URL query 参数全是字符串。尝试把"看起来像数字"的值转成数字，
  // 避免 SQLite 字符串 vs 数字比较时出现意外行为（如 HAVING "cnt" > "2" 永远为 false）。
  // 只对纯整数字符串 / 纯小数字符串做转换，不破坏真正需要字符串的场景。
  function coerceValue(v: string): string | number {
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d+\.\d+$/.test(v)) return Number(v);
    return v;
  }
  const value = coerceValue(rawValue);

  switch (op) {
    case "_eq":
      return { clause: `${qualifiedCol} = ?`, params: [value] };
    case "_neq":
      return { clause: `${qualifiedCol} <> ?`, params: [value] };
    case "_lt":
      return { clause: `${qualifiedCol} < ?`, params: [value] };
    case "_lte":
      return { clause: `${qualifiedCol} <= ?`, params: [value] };
    case "_gt":
      return { clause: `${qualifiedCol} > ?`, params: [value] };
    case "_gte":
      return { clause: `${qualifiedCol} >= ?`, params: [value] };
    case "_like":
      return { clause: `${qualifiedCol} LIKE ?`, params: [value] };
    case "_nlike":
      return { clause: `${qualifiedCol} NOT LIKE ?`, params: [value] };
    case "_contains":
      return {
        clause: `${qualifiedCol} LIKE ? ESCAPE '\\'`,
        params: [`%${escapeLike(String(value))}%`]
      };
    case "_starts_with":
      return {
        clause: `${qualifiedCol} LIKE ? ESCAPE '\\'`,
        params: [`${escapeLike(String(value))}%`]
      };
    case "_ends_with":
      return {
        clause: `${qualifiedCol} LIKE ? ESCAPE '\\'`,
        params: [`%${escapeLike(String(value))}`]
      };
    case "_in": {
      const items = splitCsv(rawValue).map(coerceValue);
      if (items.length === 0) {
        // IN () 空集：SQLite/MySQL 都报语法错误，显式抛错给前端更友好
        throw new BusinessError(
          400,
          `_in requires at least one value: ${field} | _in 至少需要一个值: ${field}`
        );
      }
      if (items.length > MAX_IN_ITEMS) {
        throw new BusinessError(400, `_in too many values (max ${MAX_IN_ITEMS}): ${field}`);
      }
      const placeholders = items.map(() => "?").join(", ");
      return { clause: `${qualifiedCol} IN (${placeholders})`, params: items };
    }
    case "_nin": {
      const items = splitCsv(rawValue).map(coerceValue);
      if (items.length === 0) {
        throw new BusinessError(
          400,
          `_nin requires at least one value: ${field} | _nin 至少需要一个值: ${field}`
        );
      }
      if (items.length > MAX_IN_ITEMS) {
        throw new BusinessError(400, `_nin too many values (max ${MAX_IN_ITEMS}): ${field}`);
      }
      const placeholders = items.map(() => "?").join(", ");
      return { clause: `${qualifiedCol} NOT IN (${placeholders})`, params: items };
    }
    case "_null": {
      const flag = isTruthy(rawValue);
      return { clause: flag ? `${qualifiedCol} IS NULL` : `${qualifiedCol} IS NOT NULL`, params: [] };
    }
    case "_nnull":
    case "_not_null": {
      // _not_null = _nnull 同义（总是 IS NOT NULL，不依赖 value）
      return { clause: `${qualifiedCol} IS NOT NULL`, params: [] };
    }
    case "_between": {
      const [minStr, maxStr, ...rest] = splitCsv(rawValue);
      if (minStr === undefined || maxStr === undefined || rest.length > 0) {
        throw new BusinessError(
          400,
          `_between requires exactly 2 comma-separated values: ${field}`
        );
      }
      return {
        clause: `${qualifiedCol} BETWEEN ? AND ?`,
        params: [coerceValue(minStr), coerceValue(maxStr)]
      };
    }
    default:
      // 编译期兜底：VALID_OPS 已经校验过，这里理论不可达
      throw new BusinessError(400, `Unknown operator: ${op} | 未知运算符: ${op}`);
  }
}

/** 转义 LIKE 通配符 % _ 为字面量，然后再在两端加 % 等 —— 只用于 contains/starts_with/ends_with */
function escapeLike(s: string): string {
  return s.replace(/([%_\\])/g, "\\$1");
}

/** 逗号分隔 CSV（支持空格前后有 trim），空串返回 [] */
function splitCsv(s: string): string[] {
  return s
    .split(",")
    .map(x => x.trim())
    .filter(x => x.length > 0);
}

/** 将字符串解释为布尔（Directus 约定：1/true/on/yes 为真） */
function isTruthy(s: string): boolean {
  return ["1", "true", "on", "yes"].includes(s.toLowerCase());
}

/**
 * 将 AST 渲染为 SQL WHERE 片段 + 参数列表。
 * AND/OR 节点用括号包裹，确保组合运算优先级正确。
 */
function renderAst(
  ast: FilterAst,
  schema: TableSchema,
  dsType: string,
  extraAllowedColumns?: Set<string>,
  joins?: JoinDesc[]
): { clause: string; params: unknown[] } {
  if (ast.kind === "atom") {
    return renderAtom(ast.atom, schema, dsType, extraAllowedColumns, joins);
  }
  const childParts = ast.children.map(c => renderAst(c, schema, dsType, extraAllowedColumns, joins));
  // 过滤空子节点（不应出现，保守防御）
  const valid = childParts.filter(p => p.clause.length > 0);
  if (valid.length === 0) return { clause: "", params: [] };
  if (valid.length === 1) return valid[0];
  const joiner = ast.kind === "and" ? " AND " : " OR ";
  const clause = valid.map(v => `(${v.clause})`).join(joiner);
  const params = valid.flatMap(v => v.params);
  return { clause, params };
}

/**
 * 对外主入口：query 字典 → { where: SQL, params: 数组 }。
 *
 * @param query    URLSearchParams 扁平后的 dict（值都是 string）
 * @param schema   表结构发现结果，用于列名白名单校验
 * @param dsType   数据源类型（sqlite / mysql）—— 决定 quoteId 用反引号还是双引号
 * @param reserved 已在路由层被用作特殊用途的 key（page, pageSize, nopage, __one, orderBy, order 等）
 */
export function buildFilterFromQuery(
  query: Record<string, string>,
  schema: TableSchema,
  dsType: string,
  reserved: Set<string>,
  extraAllowedColumns?: Set<string>,
  joins?: JoinDesc[]
): { clause: string; params: unknown[] } {
  const ast = parseFiltersFromQuery(query, reserved);
  if (!ast) return { clause: "", params: [] };
  return renderAst(ast, schema, dsType, extraAllowedColumns, joins);
}

// ============================================================================
// 列选择 + 聚合函数 + GROUP BY + 多字段 ORDER BY（Directus 风格扩展）
// ============================================================================

/** 允许的聚合函数枚举；防止自定义函数拼入 SQL */
const VALID_AGG: Record<string, true> = {
  count: true,
  countDistinct: true, // COUNT(DISTINCT col)
  sum: true,
  avg: true,
  min: true,
  max: true,
  groupConcat: true, // GROUP_CONCAT(col) / string_agg(col, ',') → SQLite/MySQL 差异用别名
  total: true // count(*) 的简写
};

/** 单个 SELECT 项 */
interface SelectItem {
  /** 拼入 SQL 的表达式，已被安全构建（quoteId + 枚举函数） */
  sql: string;
  /** 最终别名（列名原样 / 用户指定 as / 聚合自动生成 aliases）；用于输出列顺序 */
  alias: string;
}

/** 列标识符合法性检查（字母数字下划线+点，点用于将来关联表，当前仅允许单列） */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 别名字符校验：字母数字下划线 */
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 fields / aggregate 为 SELECT 项列表。
 *
 * 参数：
 *   fieldsCSV   形如 "*"（默认） 或 "id,name,price"；
 *               空串 / "*" → "*"，当出现 aggregate 时默认无原始列
 *               （显式写 fields=status 会带出该分组列）。
 *   aggregate   形如 aggregate[count][*]=total_count
 *                     &aggregate[sum][price]=total_price
 *                     &aggregate[avg][qty]=avg_qty
 *                     &aggregate[countDistinct][status]=statuses
 *                     &aggregate[min][price]=min_p
 *                     &aggregate[max][price]=max_p
 *               键规则：aggregate[<fn>][<field>]=<alias>
 *                 fn 必须在 VALID_AGG 中
 *                 field 必须是 schema 列名或单独字符 "*"
 *                 alias 必须匹配 ALIAS_RE
 *
 * 返回值：
 *   selectList: 顺序的 SELECT 表达式数组（每项包含 sql + alias）
 *               可直接 join(', ') 组成 SELECT 列表
 */
export function parseProjection(
  fieldsCSV: string | undefined,
  aggregate: Record<string, string>,
  schema: TableSchema,
  dsType: string
): { selectList: SelectItem[]; hasAggregates: boolean } {
  const selectList: SelectItem[] = [];
  const hasAggregates = Object.keys(aggregate).length > 0;

  // —— aggregate 先加到 select（为了「有聚合默认不选原始列」策略） ——
  // Directus 约定用 parseAggregate 扁平化：aggregate[count][*]=total_count
  // 由于 URLSearchParams 会把这种结构扁平成 aggregate[count][*] 单 key，
  //   我们自定义解析函数 parseAggregateParams。
  const aggItems = parseAggregateParams(aggregate);
  for (const item of aggItems) {
    if (!VALID_AGG[item.fn]) {
      throw new BusinessError(
        400,
        `Invalid aggregate function: ${item.fn} (only count/countDistinct/sum/avg/min/max/groupConcat/total allowed)`
      );
    }
    if (!ALIAS_RE.test(item.alias)) {
      throw new BusinessError(
        400,
        `Invalid aggregate alias: ${item.alias} (letters/numbers/underscore only) | 聚合别名无效（仅允许字母/数字/下划线）`
      );
    }
    const sql = renderAggregate(item.fn, item.field, schema, dsType);
    selectList.push({ sql: `${sql} AS ${quoteId(item.alias, dsType)}`, alias: item.alias });
  }

  // —— fields 原始列选择：无 aggregate 时默认 "*"，否则默认为空（仅聚合列）——
  let fieldParts: string[];
  if (fieldsCSV === undefined || fieldsCSV === "" || fieldsCSV === "*") {
    fieldParts = hasAggregates ? [] : ["*"];
  } else {
    fieldParts = splitCsv(fieldsCSV);
  }
  for (const f of fieldParts) {
    if (f === "*") {
      selectList.push({ sql: "*", alias: "*" });
      continue;
    }
    if (!IDENT_RE.test(f)) {
      throw new BusinessError(400, `Invalid field in fields: ${f} | fields 中的字段无效: ${f}`);
    }
    if (!schema.columnNames.has(f)) {
      throw new BusinessError(400, `Unknown column in fields: ${f} | fields 中的列未知: ${f}`);
    }
    selectList.push({ sql: quoteId(f, dsType), alias: f });
  }

  if (selectList.length === 0) {
    // 极少情况：只写了 aggregate=? 但没写任何合法项 → 兜底 SELECT 1（仍会跑聚合返回结果）
    selectList.push({ sql: "1", alias: "_dummy" });
  }

  return { selectList, hasAggregates };
}

/** 把 aggregate[...] 扁平字典展开为 {fn, field, alias}[]。
 *
 *  输入 keys 形态（URLSearchParams 平铺的结果）：
 *     "aggregate[count][*]"        → "total_count"
 *     "aggregate[sum][price]"      → "total_price"
 *     "aggregate[countDistinct][status]" → "distinct_statuses"
 *     "aggregate[total][]" （或 aggregate[total][*]）→ "c"
 */
function parseAggregateParams(
  aggregate: Record<string, string>
): Array<{ fn: string; field: string; alias: string }> {
  const out: Array<{ fn: string; field: string; alias: string }> = [];
  for (const [k, alias] of Object.entries(aggregate)) {
    // 键可能是 "aggregate[count][*]" 或 "count][*"（看前端用不同 query-string 库），
    // 为统一：我们先剥掉开头 "aggregate[" （如带），再用正则抓 "[fn][field]"
    const body = k.startsWith("aggregate[") ? k.slice("aggregate".length) : k;
    const m = body.match(/^\[([a-zA-Z_]+)\]\[([^\]]*)\]$/);
    if (!m) {
      throw new BusinessError(
        400,
        `Invalid aggregate key: ${k}. Expected aggregate[<fn>][<field>]=<alias> | 聚合键无效，应为 aggregate[<fn>][<field>]=<alias>`
      );
    }
    const fn = m[1];
    let field = m[2];
    // count / total 允许 [*]，其它函数必须给真实列
    if (!field || field === "*") field = "*";
    out.push({ fn, field, alias });
  }
  return out;
}

/** 渲染单个聚合函数；字段走 schema 白名单（* 除外），函数名走 VALID_AGG */
function renderAggregate(fn: string, field: string, schema: TableSchema, dsType: string): string {
  // 仅 count / total 允许 "*"
  if (field === "*") {
    if (fn === "count" || fn === "total") return "COUNT(*)";
    throw new BusinessError(400, `Aggregate ${fn} requires a column argument (not *)`);
  }
  // 其它：列必须存在
  if (!schema.columnNames.has(field)) {
    throw new BusinessError(
      400,
      `Unknown column in aggregate(${fn}): ${field} | 聚合 ${fn} 中的列未知: ${field}`
    );
  }
  const col = quoteId(field, dsType);
  switch (fn) {
    case "count":
      return `COUNT(${col})`;
    case "countDistinct":
      return `COUNT(DISTINCT ${col})`;
    case "sum":
      return `SUM(${col})`;
    case "avg":
      return `AVG(${col})`;
    case "min":
      return `MIN(${col})`;
    case "max":
      return `MAX(${col})`;
    case "groupConcat":
      // SQLite & MySQL 都支持 GROUP_CONCAT(col)，分隔符默认逗号
      return `GROUP_CONCAT(${col})`;
    case "total":
      // total 在列上等价于 COUNT(col)
      return `COUNT(${col})`;
    default:
      // 理论不可达（VALID_AGG 校验过）
      throw new BusinessError(400, `Unknown aggregate function: ${fn} | 未知聚合函数: ${fn}`);
  }
}

/**
 * 解析 groupBy CSV，每列 schema 白名单校验。
 *
 * 典型写法：groupBy=status,author_id
 *   返回 ["status","author_id"]，SQL → GROUP BY "status", "author_id"
 */
export function parseGroupBy(
  groupByCSV: string | undefined,
  schema: TableSchema,
  dsType: string
): string[] {
  if (!groupByCSV) return [];
  const cols = splitCsv(groupByCSV);
  const out: string[] = [];
  for (const c of cols) {
    if (!IDENT_RE.test(c))
      throw new BusinessError(400, `Invalid column in groupBy: ${c} | groupBy 中的列无效: ${c}`);
    if (!schema.columnNames.has(c)) {
      throw new BusinessError(400, `Unknown column in groupBy: ${c} | groupBy 中的列未知: ${c}`);
    }
    out.push(quoteId(c, dsType));
  }
  return out;
}

/**
 * 解析多字段 orderBy（单字段 orderBy=col 仍兼容，多字段逗号分隔）。
 *   orderBy=created_at,name
 *   order=desc           → 所有列都用 desc（向后兼容）
 *   扩展语法：orderBy=created_at:desc,name:asc（Directus 的冒号写法）
 *
 * extraAllowedColumns: 聚合别名集合（如 new Set(["cnt", "total_price"])），
 *   当 SELECT 中有 GROUP BY / 聚合别名时，允许用别名排序。
 *
 * 返回 SQL 片段（不含 "ORDER BY" 前缀）。空数组返回空串。
 */
export function parseOrderBy(
  orderByCSV: string | undefined,
  order: string | undefined,
  schema: TableSchema,
  dsType: string,
  extraAllowedColumns?: Set<string>,
  joins?: JoinDesc[]
): string {
  if (!orderByCSV) return "";
  const parts = splitCsv(orderByCSV);
  const items: string[] = [];
  const globalDir = order?.toLowerCase() === "desc" ? "DESC" : "ASC";
  for (const p of parts) {
    // 允许 col:direction 或 as.col:direction
    const [colName, dirOverride] = p.split(":", 2);
    // IDENT_RE 校验：有 "." 时拆成 prefix + subField 分别校验
    const dotIdx = colName.indexOf(".");
    let prefix = "";
    let subField = "";
    if (dotIdx > 0) {
      prefix = colName.slice(0, dotIdx);
      subField = colName.slice(dotIdx + 1);
      if (!IDENT_RE.test(prefix) || !IDENT_RE.test(subField)) {
        throw new BusinessError(
          400,
          `Invalid column in orderBy: ${colName} | orderBy 中的列无效: ${colName}`
        );
      }
    } else {
      if (!IDENT_RE.test(colName)) {
        throw new BusinessError(
          400,
          `Invalid column in orderBy: ${colName} | orderBy 中的列无效: ${colName}`
        );
      }
    }

    let qualifiedCol: string;
    // 子表列识别：含 "." → <as>.<col> 或 <table>.<col>
    if (dotIdx > 0) {
      if (!joins || joins.length === 0) {
        throw new BusinessError(
          400,
          `Sub-table column in orderBy but no joins: ${colName} | orderBy 使用了子表列但没有 JOIN: ${colName}`
        );
      }
      const joinIdx = joins.findIndex(j => j.as === prefix || j.table === prefix);
      if (joinIdx < 0) {
        throw new BusinessError(
          400,
          `Unknown join prefix "${prefix}" in orderBy: ${colName} | orderBy 中 join 前缀未知: ${colName}`
        );
      }
      const join = joins[joinIdx];
      if (!join.schema || !join.schema.columnNames.has(subField)) {
        throw new BusinessError(
          400,
          `Unknown column "${subField}" in join "${prefix}" for orderBy | 子表列未知: ${colName}`
        );
      }
      qualifiedCol = `${quoteId(joinTableAlias(joinIdx), dsType)}.${quoteId(subField, dsType)}`;
    } else {
      // 主表列或聚合别名
      const isAggAlias = extraAllowedColumns?.has(colName) ?? false;
      if (!isAggAlias && !schema.columnNames.has(colName)) {
        throw new BusinessError(
          400,
          `Unknown column in orderBy: ${colName} | orderBy 中的列未知: ${colName}`
        );
      }
      // 有 JOIN 时主表列需要限定表别名前缀
      qualifiedCol = joins && joins.length > 0
        ? `${quoteId(MAIN_TABLE_ALIAS, dsType)}.${quoteId(colName, dsType)}`
        : quoteId(colName, dsType);
    }

    let dir = globalDir;
    if (dirOverride) {
      const d = dirOverride.toLowerCase();
      if (d !== "asc" && d !== "desc") {
        throw new BusinessError(
          400,
          `Invalid direction in orderBy: ${p} (must be asc or desc) | orderBy 排序方向无效（必须是 asc 或 desc）`
        );
      }
      dir = d === "desc" ? "DESC" : "ASC";
    }
    items.push(`${qualifiedCol} ${dir}`);
  }
  if (items.length === 0) return "";
  return items.join(", ");
}

/**
 * 解析 URLSearchParams 中所有 aggregate[...] 前缀的项，返回一个扁平字典。
 *
 * 例：{ "aggregate[count][*]": "total_count", "aggregate[sum][price]": "total_price" }
 *     → 透传给 parseProjection 的 aggregate 参数就用这个结构。
 *
 * 在 generic.service 里我们这么用：
 *     const agg = extractPrefixed(query, "aggregate");
 *     const { selectList, hasAggregates } = parseProjection(query.fields, agg, schema, ds.type);
 */
export function extractPrefixed(
  query: Record<string, string>,
  prefix: string
): Record<string, string> {
  const out: Record<string, string> = {};
  const p = prefix + "[";
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith(p)) out[k] = v;
  }
  return out;
}
