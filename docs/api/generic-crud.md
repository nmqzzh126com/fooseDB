---
sidebar_position: 1
title: "通用 CRUD API"
slug: "/api/generic-crud"
description: "/api/:object/:table 系列 11 个端点，覆盖增删改查、批量操作、原子递增"
---

# 通用 CRUD API

所有端点统一路径：`/api/:object/:table`，支持 Directus 风格查询参数。

---

## 认证头

需要认证的请求带：

```http
Authorization: Bearer <access_token>
X-Client-Id: <客户端指纹 UUID>
```

> SDK 自动处理，业务代码无需手动设置。

---

## 响应格式

**成功**（非 blob 响应）：

```json
// list / getOne
{ "data": [...], "meta": { "total": 100, "page": 1, "pageSize": 10, "totalPages": 10 } }

// getById / create / update
{ "data": { ... } }

// 删除
{ "ok": true }

// batch-create / batch-update
{ "ok": true, "created": 5, "updated": 5, "rows": [...] }

// inc-dec
{ "ok": true, "changed": 8, "rows": [...] }
```

**错误**（Fastify 默认格式）：

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "项目 \"sqlite_demo\" 未开启文件列表权限",
  "durationMs": 0.214
}
```

| 字段         | 说明                               |
| ------------ | ---------------------------------- |
| `message`    | **业务层中文错误**（SDK 优先读取） |
| `error`      | HTTP 英文原因短语（fallback）      |
| `durationMs` | 请求耗时（毫秒）                   |

---

## 端点清单

### ① 分页查询列表

```
GET /api/:object/:table
```

| Query 参数 | 类型   | 说明                                    |
| ---------- | ------ | --------------------------------------- |
| `page`     | number | 当前页，默认 1                          |
| `pageSize` | number | 每页条数，默认 10（受 DB 限制）         |
| `filter`   | object | Directus 风格过滤（见下文）             |
| `sort`     | string | 排序，如 `id:desc` 或 `create_time:asc` |
| `fields`   | string | 返回字段白名单，逗号分隔                |
| `join`     | string | 自动 JOIN 外键表（见 join 文档）        |
| `showSql`  | string | `"1"` 或 `"true"` 时响应带 `sql` 字段   |

**示例**：

```http
GET /api/sqlite_demo/foose_product?page=1&pageSize=10&filter[product_type_id]=2&sort=id:desc
```

### ② 按 ID 查询单行

```
GET /api/:object/:table/:id
```

### ③ 按条件查询单行

```
GET /api/:object/:table/one
```

和 ① 参数相同，但只返回第一条（`LIMIT 1`）。适合查 `count(*)` 或单字段值。

### ④ 创建单行

```
POST /api/:object/:table
Content-Type: application/json

{
  "product_name": "新商品",
  "product_type_id": 1,
  "product_count": 50
}
```

- `password` 列自动 bcrypt 哈希（如果值不是 `$2` 开头）
- 支持 `autoCreateTimeStampField` 配置（见 SDK 文档）

### ⑤ 更新单行

```
PUT /api/:object/:table/:id
Content-Type: application/json

{ "product_count": 999 }
```

- 返回更新后的完整行
- 支持 `autoUpdateTimeStampField` 配置（每次 update 无条件刷新）

### ⑥ 删除单行

```
DELETE /api/:object/:table/:id
```

---

## 批量操作

### ⑦ 批量创建

```
POST /api/:object/:table/batch-create
Content-Type: application/json

{
  "rows": [
    { "product_name": "批量1", "product_type_id": 2, "product_count": 10 },
    { "product_name": "批量2", "product_type_id": 3, "product_count": 20 }
  ],
  "showSql": false
}
```

- 事务保证原子性（任一失败全部回滚）
- 表规则：`allow_batch_insert`

### ⑧ 批量更新

```
POST /api/:object/:table/batch-update
Content-Type: application/json

{
  "rows": [
    { "id": 1, "product_count": 99 },
    { "id": 2, "product_count": 199 }
  ]
}
```

- 每一行必须带 `id`
- 事务保证原子性
- 表规则：`allow_batch_update`

### ⑨ 批量删除（按 ID）

```
POST /api/:object/:table/batch-delete
Content-Type: application/json

{ "ids": [1, 2, 3] }
```

- 事务保证原子性
- 表规则：`allow_batch_delete`

### ⑩ 批量删除（按 filter）

```
POST /api/:object/:table/batch-delete-filter
Content-Type: application/json

{
  "filter": { "product_type_id": 5 }
}
```

- 比按 ID 删除更强大：任意 Directus filter
- 表规则：`allow_batch_delete`

---

## ⑪ 原子自增 / 自减

```
POST /api/:object/:table/inc-dec?filter[product_type_id]=2&delay=1000
Content-Type: application/json

{
  "inc": { "product_count": 5 },
  "dec": { "stock_warn": 3 }
}
```

| 参数     | 类型   | 说明                                      |
| -------- | ------ | ----------------------------------------- |
| `inc`    | object | 自增：`{ 字段名: 增量 }`，默认 1          |
| `dec`    | object | 自减：`{ 字段名: 减量 }`，默认 1          |
| `filter` | query  | Directus 风格条件，**必须带**（幂等安全） |
| `delay`  | query  | 毫秒延迟，上限 30000ms，用于前端演示时序  |

**表规则**：`allow_update`（不是 `allow_batch_update`，因为本质是 UPDATE 操作）

### 特性

- 同一字段同时出现在 inc 和 dec 中会合并代数和（如 inc:a=5 + dec:a=2 → a += 3）
- 多行匹配时全部更新
- SQLite 下 `field = field + N` 原子语句，无竞态
- `filter` 为空时默认影响全部行（SDK 封装强制传 filter）

---

## Directus 风格过滤语法

所有 `filter` 参数用 object 嵌套表示条件：

| 操作符   | 语法                                            | 含义                               |
| -------- | ----------------------------------------------- | ---------------------------------- |
| 等于     | `filter[name]=张三` 或 `filter[name][_eq]=张三` | WHERE name = '张三'                |
| 不等于   | `filter[name][_neq]=李四`                       | WHERE name != '李四'               |
| 大于     | `filter[price][_gt]=100`                        | WHERE price > 100                  |
| 大于等于 | `filter[price][_gte]=100`                       | WHERE price >= 100                 |
| 小于     | `filter[price][_lt]=50`                         | WHERE price &#60; 50               |
| 小于等于 | `filter[price][_lte]=50`                        | WHERE price &#60;= 50              |
| 包含     | `filter[product_name][_contains]=电`            | WHERE product_name LIKE '%电%'     |
| 不包含   | `filter[product_name][_ncontains]=电`           | WHERE product_name NOT LIKE '%电%' |
| 为空     | `filter[description][_null]=1`                  | WHERE description IS NULL          |
| 不为空   | `filter[description][_nnull]=1`                 | WHERE description IS NOT NULL      |
| 列表     | `filter[status][_in]=1,3,5`                     | WHERE status IN (1, 3, 5)          |
| 不在列表 | `filter[status][_nin]=2,4`                      | WHERE status NOT IN (2, 4)         |

**白名单防注入**：字段名和操作符都经过校验，不允许任意 SQL 片段。

---

## JOIN 自动关联

基于外键关系自动拼接：

```http
GET /api/sqlite_demo/foose_product?join=product_type&sort=id:desc
```

或者高级配置：

```json
{
  "joins": [
    {
      "table": "foose_product_type",
      "as": "pt",
      "type": "one",
      "on": { "local": "product_type_id", "foreign": "id" }
    }
  ]
}
```

---

## 密码字段自动处理

后端自动识别列名含 `password` 的列：

- **写入时**：如果值不是 `$2` 开头，自动 bcrypt 哈希（cost=10）
- **读取时**：返回值被屏蔽为空字符串（保护敏感数据）

无需业务层任何处理。
