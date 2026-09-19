# FooseDB 通用 CRUD 接口文档

> Base URL: `http://localhost:8858`  
> 所有端点前缀: `/api/:object/:table`  
> 认证方式: `Authorization: Bearer <access_token>`（除登录外所有端点必填）

---

## 通用约定

### 路径参数

| 参数 | 说明 | 示例 |
|---|---|---|
| `object` | 数据源标识（配置在 `datasources.ts`） | `sqlite_demo` |
| `table` | 目标表名 | `product`, `product_label` |
| `id` | 主键值（单条操作） | `42` 或 UUID 字符串 |

### 统一错误响应

所有错误返回 `{ error: string }`，HTTP 状态码语义化：

| 状态码 | 含义 |
|---|---|
| 400 | 参数校验失败 / 业务约束违反（如空 filter、行数超限） |
| 401 | 未认证 / token 过期 |
| 403 | 无权限（select / insert / update / delete 各自独立） |
| 404 | 资源不存在 |
| 500 | 数据库异常（`showSql=true` 时额外返回 `sql` / `sqlParams`） |

### 安全上限

| 常量 | 值 | 说明 |
|---|---|---|
| `PAGE_SIZE_MAX` | 500 | 分页查询 pageSize 上限 |
| `PAGE_SIZE_DEFAULT` | 20 | 分页查询 pageSize 默认值 |
| `MAX_DELETE_ROWS` | 500 | 批量删除（ids / filter）行数上限 |
| `MAX_BATCH_ROWS` | 500 | 批量创建 / 批量更新行数上限 |

---

## 1. 查询列表

### `GET /api/:object/:table`

分页 / 不分页 / 按条件查一行。

#### Query Parameters

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | number | 否 | 当前页码，从 1 开始。默认 1 |
| `pageSize` | number | 否 | 每页条数，默认 20，上限 500 |
| `noPage` / `nopage` | boolean | 否 | `true` 时返回全量数组（无分页信封） |
| `__one` | boolean | 否 | `true` 时按 filter 查一行（零结果返回 `null`，不抛 404） |
| `showSql` | boolean | 否 | `true` 时响应额外返回 `sql` + `sqlParams` |
| `orderBy` | string \| string[] | 否 | 排序，多字段逗号分隔，每字段自带方向。例: `"product_count:desc,id:asc"` |
| `order` | string | 否 | 全局方向（仅当 orderBy 没带方向时生效），`asc` / `desc` |
| `groupBy` | string \| string[] | 否 | GROUP BY 字段，逗号分隔 |
| `fields` | string \| string[] | 否 | 返回列白名单，逗号分隔 |
| `join` | string | 否 | JOIN 结构化数组序列化格式（见「JOIN 语法」章节） |
| `filter[col]` | any | 否 | Directus 风格过滤（见「Filter 语法」章节） |
| `aggregate[...]` | — | 否 | 聚合函数（结构化 flatten 后） |
| `having[...]` | — | 否 | HAVING 条件（结构化 flatten 后） |

#### 响应 — 分页模式

```json
{
  "data": [
    { "id": 1, "product_name": "联想ThinkPad", "product_count": 150 }
  ],
  "meta": {
    "mode": "paginated",
    "total": 47,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  },
  "sql": "SELECT ... LIMIT ? OFFSET ?",
  "sqlParams": [20, 0]
}
```

#### 响应 — noPage 模式

```json
// 默认仅返回数组（向后兼容）
[{ "id": 1, "product_name": "联想ThinkPad", "product_count": 150 }]

// showSql=true 时返回完整信封
{
  "data": [...],
  "meta": { "mode": "nopage", "total": 47 },
  "sql": "SELECT ...",
  "sqlParams": []
}
```

#### 响应 — `__one` 模式

```json
{ "id": 1, "product_name": "联想ThinkPad", "product_count": 150 }
// 或 null（零结果）
```

---

## 2. 按主键查一行

### `GET /api/:object/:table/:id`

#### Query Parameters

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fields` | string | 否 | 返回列白名单，逗号分隔 |
| `join` | string | 否 | JOIN 序列化格式 |

#### 响应

```json
{ "id": 1, "product_name": "联想ThinkPad", "product_count": 150 }
```

找不到返回 404 `{ error: "Row not found" }`。

---

## 3. 单条创建

### `POST /api/:object/:table`

#### Request Body

```json
{
  "product_name": "联想ThinkPad X1",
  "product_count": 150,
  "product_type_id": 2
}
```

#### Query Parameters

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fields` | string | 否 | 指定 insert 字段白名单（不传则用请求体全部字段） |

#### 响应 `201 Created`

```json
{
  "ok": true,
  "row": { "id": 10, "product_name": "联想ThinkPad X1", "product_count": 150, "...": "..." }
}
```

---

## 4. 单条更新

### `PUT /api/:object/:table/:id`

#### Request Body

```json
{
  "product_name": "联想ThinkPad X1 Carbon",
  "product_count": 200
}
```

仅传需要更新的字段，未传字段保持原值。主键字段自动忽略。

#### Query Parameters

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fields` | string | 否 | 指定更新字段白名单 |

#### 响应

```json
{
  "ok": true,
  "row": { "id": 10, "product_name": "联想ThinkPad X1 Carbon", "product_count": 200, "...": "..." }
}
```

找不到返回 404。

---

## 5. 单条删除

### `DELETE /api/:object/:table/:id`

#### 响应

```json
{ "ok": true, "deleted": 1 }
```

找不到返回 404。

---

## 6. 批量创建

### `POST /api/:object/:table/batch-create`

事务原子 — 任一行插入失败全部回滚。

#### Request Body

```json
{
  "rows": [
    { "product_name": "A", "product_count": 10 },
    { "product_name": "B", "product_count": 20 },
    { "product_name": "C", "product_count": 30 }
  ]
}
```

#### Query Parameters

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `showSql` | boolean | 否 | `true` 时返回实际执行的 INSERT SQL |

#### 响应 `201 Created`

```json
{
  "ok": true,
  "created": 3,
  "rows": [
    { "id": 11, "product_name": "A", "product_count": 10 },
    { "id": 12, "product_name": "B", "product_count": 20 },
    { "id": 13, "product_name": "C", "product_count": 30 }
  ],
  "sql": "INSERT INTO \"product\" (\"product_name\",\"product_count\") VALUES (?,?),(?,?),(?,?)",
  "sqlParams": ["A", 10, "B", 20, "C", 30]
}
```

#### 错误场景

| 条件 | HTTP | 错误信息 |
|---|---|---|
| `rows` 非数组或空数组 | 400 | `rows must be a non-empty array` |
| `rows.length > 500` | 400 | `rows exceeds MAX_BATCH_ROWS (500)` |
| 任一行 UNIQUE 冲突 / FK 约束 | 400/500 | 原始数据库错误信息（事务已全量回滚） |

---

## 7. 批量更新

### `POST /api/:object/:table/batch-update`

事务原子 — 任一行更新失败全部回滚。

#### Request Body

```json
{
  "rows": [
    { "id": 11, "product_name": "新A", "product_count": 100 },
    { "id": 12, "product_name": "新B" },
    { "id": 13, "product_count": 300 }
  ]
}
```

每行**必须**带 `id` 字段（主键），其余字段为需要 patch 的值。

#### Query Parameters

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `showSql` | boolean | 否 | `true` 时返回第一条 UPDATE SQL 模板 |

#### 响应

```json
{
  "ok": true,
  "updated": 3,
  "rows": [
    { "id": 11, "product_name": "新A", "product_count": 100 },
    { "id": 12, "product_name": "新B", "product_count": 20 },
    { "id": 13, "product_name": "C", "product_count": 300 }
  ],
  "sql": "UPDATE \"product\" SET ... WHERE \"id\" = ?",
  "sqlParams": [...]
}
```

#### 错误场景

| 条件 | HTTP | 错误信息 |
|---|---|---|
| `rows` 非数组或空数组 | 400 | `rows must be a non-empty array` |
| `rows.length > 500` | 400 | `rows exceeds MAX_BATCH_ROWS (500)` |
| 某行缺少 `id` 字段 | 400 | `each row must contain 'id' field` |
| 任一行主键不存在 | 404 | 原始数据库错误（事务已全量回滚） |

---

## 8. 批量删除 — 按 ids

### `POST /api/:object/:table/batch-delete`

#### Request Body

```json
{ "ids": [11, 12, 13] }
```

#### Query Parameters

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `showSql` | boolean | 否 | `true` 时返回 DELETE SQL |

#### 响应

```json
{
  "ok": true,
  "deleted": 3,
  "sql": "DELETE FROM \"product\" WHERE \"id\" IN (?,?,?)",
  "sqlParams": [11, 12, 13]
}
```

#### 错误场景

| 条件 | HTTP | 错误信息 |
|---|---|---|
| `ids` 非数组或空数组 | 400 | `ids must be a non-empty array` |
| `ids.length > 500` | 400 | `ids exceeds MAX_DELETE_ROWS (500)` |

---

## 9. 批量删除 — 按 filter

### `POST /api/:object/:table/batch-delete-filter`

复用列表查询的 Filter 语法。**空 filter 默认禁止**（防止误删全表）。

#### Request Body

```json
{
  "filter": {
    "product_type_id": 2,
    "product_count": { "_lt": 10 }
  }
}
```

#### Query Parameters

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `showSql` | boolean | 否 | `true` 时返回 DELETE SQL |

#### 响应

```json
{
  "ok": true,
  "deleted": 7,
  "sql": "DELETE FROM \"product\" WHERE \"product_type_id\" = ? AND \"product_count\" < ?",
  "sqlParams": [2, 10]
}
```

#### 错误场景

| 条件 | HTTP | 错误信息 |
|---|---|---|
| `filter` 为空对象 `{}` | 400 | `filter must be a non-empty object` |
| filter 命中行数 > 500 | 400 | `delete exceeds MAX_DELETE_ROWS (500)` |

---

## Filter 语法

Directus 风格，支持 15 种运算符 + OR/AND 嵌套 + 跨表（子表列）过滤。

### 基础形式

```
col = value            → 等值
col[op] = value        → 带运算符
```

### 15 种运算符

| 运算符 | SQL 等价 | 类型约束 | 示例 |
|---|---|---|---|
| `_eq` | `=` | 任意 | `status[_eq]=1` |
| `_neq` | `!=` | 任意 | `status[_neq]=0` |
| `_gt` | `>` | 数值 | `price[_gt]=100` |
| `_gte` | `>=` | 数值 | `price[_gte]=50` |
| `_lt` | `<` | 数值 | `price[_lt]=200` |
| `_lte` | `<=` | 数值 | `price[_lte]=150` |
| `_in` | `IN` | 逗号分隔值 | `id[_in]=1,2,5` |
| `_nin` | `NOT IN` | 逗号分隔值 | `id[_nin]=0,99` |
| `_like` | `LIKE` | 字符串 | `name[_like]=%联想%` |
| `_nlike` | `NOT LIKE` | 字符串 | `name[_nlike]=%戴尔%` |
| `_starts_with` | `LIKE 'val%'` | 字符串 | `name[_starts_with]=Think` |
| `_ends_with` | `LIKE '%val'` | 字符串 | `name[_ends_with]=X1` |
| `_between` | `BETWEEN` | 数组 `[min,max]` | `price[_between]=100,500` |
| `_null` | `IS NULL` / `IS NOT NULL` | boolean | `deleted_at[_null]=true` |
| `_not_null` | `IS NOT NULL` | boolean | `deleted_at[_not_null]=true` |

### OR / AND 嵌套

```json
{
  "_or": [
    { "product_name[_like]": "%联想%" },
    { "product_name[_like]": "%戴尔%" }
  ],
  "_and": [
    { "status": 1 },
    { "price[_gt]": 100 }
  ]
}
```

可任意深度嵌套。

### 跨表（子表列）过滤

有 JOIN 时，用 `<alias>.<column>[op]` 语法：

```json
{
  "pdt.product_name[_like]": "%联想%",
  "pt.status": 1
}
```

---

## JOIN 语法

### 前端结构化写法（推荐）

```ts
joins: [
  { table: "product_type" },                                          // 全自动推断
  { table: "product_label", type: "many" },                            // 1:N 关系
  { table: "product_type", type: "one", as: "pt", joinType: "inner" }, // 指定别名 + INNER JOIN
  { table: "product_label", on: "product_id" },                       // 指定 FK 列
  { table: "product", on: { local: "product_id", foreign: "id" } }    // 双向显式
]
```

### URL 序列化格式

```
join=table:type:as:onCol:joinType,table:type:as:onCol:joinType
```

| 位置 | 字段 | 省略时 | 说明 |
|---|---|---|---|
| 1 | `table` | 必填 | 子表名 |
| 2 | `type` | 空字符串 | `one` / `many` |
| 3 | `as` | 空字符串 | 输出嵌套字段别名 |
| 4 | `onCol` | 空字符串 | `"local=foreign"` 双向语法 |
| 5 | `joinType` | 空字符串 | `left`（默认） / `inner` |

**省略必须占位**：`product_type:one:::` 是合法的（type=one, as=空, on=空, joinType=空→LEFT JOIN）。

### 关系类型

| `type` | 含义 | 输出结构 | FK 位置 |
|---|---|---|---|
| `one` | 1:1 | `alias: { ...row }` 或 `null` | FK 在**主表** |
| `many` | 1:N | `alias: [ ...rows ]` | FK 在**子表** |

### 输出嵌套示例

请求：`GET /api/sqlite_demo/product?join=product_type:one:pt::,product_label:many:pl::`

```json
{
  "data": [
    {
      "id": 1,
      "product_name": "联想ThinkPad",
      "pt": { "id": 2, "type_name": "笔记本" },   // one → object
      "pl": [                                      // many → array
        { "id": 1, "title": "热销", "flag": 0 },
        { "id": 2, "title": "新品", "flag": 1 }
      ]
    }
  ]
}
```

### many JOIN 与分页

当存在 `many JOIN`（1:N 关系）且请求分页时，后端自动走**两步子查询**：

1. `SELECT DISTINCT __m.id FROM ... JOIN ... ORDER BY ... LIMIT ? OFFSET ?` — 先确定当前页的主表 pk
2. `SELECT __m.*, pt.*, pl.* FROM ... JOIN ... WHERE __m.id IN (...) ORDER BY ...` — 用 pk IN 回查完整数据

这样保证**每页主表条数稳定**（不会因为 JOIN 膨胀而缺行）。

---

## 前端三层接口对照

### FooseClient（纯函数，无状态）

```ts
import { createFooseClient } from "@/api/foose_db";

const foose = await createFooseClient({ username, password });

foose.fooseList<T>(object, table, params)           // → Promise<FoosePage<T>>
foose.fooseGet<T>(object, table, id, { fields, join })  // → Promise<T>
foose.fooseGetBy<T>(object, table, params)          // → Promise<T | null>
foose.fooseCreate<T>(object, table, data)           // → Promise<T>       (拆 .row)
foose.fooseUpdate<T>(object, table, id, data)       // → Promise<T>       (拆 .row)
foose.fooseRemove(object, table, id)                // → Promise<{ok, deleted}>
foose.fooseCreates<T>(object, table, rows, showSql?)// → Promise<{ok, created, rows, sql?}>
foose.fooseUpdates<T>(object, table, rows, showSql?)// → Promise<{ok, updated, rows, sql?}>
foose.fooseRemoves(object, table, ids, showSql?)     // → Promise<{ok, deleted, sql?}>
foose.fooseRemoveByFilter(object, table, filter, showSql?) // → Promise<{ok, deleted, sql?}>
```

### FooseComposable（Vue 3 组合式，有状态）

```ts
const { useProduct } = await createUseFoose({ object, table, prefix: "product" });
const {
  productDbDataList,     // Ref<T[]>       — 自动同步 data
  productDbLoading,      // Ref<boolean>   — 请求中
  productDbError,        // Ref<string|null>
  productDbPage,         // Ref<number>
  productDbPageSize,     // Ref<number>
  productDbTotal,        // Ref<number>

  productDbList,         // (params?) → Promise<FoosePage<T>>
  productDbGet,          // (id, fields?, join?) → Promise<T>
  productDbGetBy,        // (params) → Promise<T | null>
  productDbCreate,       // (data) → Promise<T>            — 自动 unshift 到 dataList
  productDbCreates,     // (rows, showSql?) → Promise<{...}> — 自动 unshift 新行
  productDbUpdate,       // (id, data) → Promise<T>       — 自动替换 dataList 中对应行
  productDbUpdates,      // (rows, showSql?) → Promise<{...}> — 自动批量替换
  productDbRemove,       // (id) → Promise<{ok, deleted}>  — 自动 splice
  productDbRemoves,      // (ids, showSql?) → Promise<{...}> — 自动批量 splice
  productDbRemovesByFilter, // (filter, showSql?) → Promise<{...}> — 不走 loading 状态
  productDbReset         // () → void  清空所有状态
} = useProduct();
```

**PrefixedComposable 规则**：所有方法名 = `prefix` + `Db` + `FooseClient 方法名`。  
例：`prefix="productLabel"` → `fooseCreates` → `productLabelDbCreates`。

### 纯函数 API（工厂另导出）

```ts
const productApi = createFooseApi({ object, table, prefix: "product" });
// 无 Db 中缀，直接 prefix + 方法名
productApi.list(params)
productApi.get(id)
productApi.create(data)
productApi.creates(rows, showSql?)
productApi.update(id, data)
productApi.updates(rows, showSql?)
productApi.remove(id)
productApi.removes(ids, showSql?)
productApi.removeByFilter(filter, showSql?)
```

---

## 响应格式统一约定

| 操作 | 后端返回 | FooseClient 返回 | Composable 返回 |
|---|---|---|---|
| **单条 create** | `{ ok, row }` | `T`（拆 `.row`） | `T` |
| **单条 update** | `{ ok, row }` | `T`（拆 `.row`） | `T` |
| **单条 delete** | `{ ok, deleted: 1 }` | `{ ok, deleted: 1 }` | `{ ok, deleted: 1 }` |
| **批量 create** | `{ ok, created, rows, sql?, sqlParams? }` | 信封原样 | 信封原样 |
| **批量 update** | `{ ok, updated, rows, sql?, sqlParams? }` | 信封原样 | 信封原样 |
| **批量 delete(ids)** | `{ ok, deleted, sql?, sqlParams? }` | 信封原样 | 信封原样 |
| **批量 delete(filter)** | `{ ok, deleted, sql?, sqlParams? }` | 信封原样 | 信封原样 |
| **list** | `{ data, meta, sql? }` | 信封原样 | 信封原样 + 自动同步状态 |
| **get / getBy** | `T \| null` | `T \| null` | `T \| null` |

---

## 安全机制清单

| 机制 | 位置 | 默认值 | 说明 |
|---|---|---|---|
| 分页上限 | `generic.service.ts` | `PAGE_SIZE_MAX = 500` | 超过强制截断 |
| 批量行数上限 | 同上 | `MAX_BATCH_ROWS = 500` | create/update 超限抛 400 |
| 删除行数上限 | 同上 | `MAX_DELETE_ROWS = 500` | 超限定抛 400（filter 先 COUNT 校验） |
| 空 filter 禁止 | service | — | batch-delete-filter 空对象 → 400 |
| 列白名单 | insertRow / updateRow | — | 只写入 schema 已知列，忽略额外字段 |
| 权限控制 | generic.ts route | 按 `select/insert/update/delete` 独立 | 无权限 → 403 |
| showSql 仅调试 | — | — | 暴露表名列名，生产环境建议关闭 |

---

## 错误码速查

| HTTP | Service | 前端处理建议 |
|---|---|---|
| 400 | `BusinessError` | 参数缺失 / 约束违反，检查请求体 |
| 401 | 中间件 | token 过期 → 自动 refresh → 重放 |
| 403 | `resolveObjectAccess` | 当前用户无该表该操作权限 |
| 404 | `getById` 返回 null | 主键不存在 |
| 500 | 原始数据库异常 | 检查 SQL（`showSql=true`），可能是 schema 不匹配 |
