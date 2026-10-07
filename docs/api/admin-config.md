---
sidebar_position: 4
title: "配置管理 API"
slug: "/api/admin-config"
description: "项目 CRUD / 表规则 CRUD / 连接测试 — 管理后台专用，操作 app.db 配置库"
---

# 配置管理 API

这组接口**只在管理后台（admin-vue）内部使用**，操作 app.db 配置库的 object 和 object_table 表。

> 通用 CRUD API **故意禁止**访问 object / object_table 表（CONFIG_GUARDED_TABLES），防止外部绕过管理后台直接修改配置。

---

## 路由总览

| HTTP   | 路径                                  | 功能                     |
| ------ | ------------------------------------- | ------------------------ |
| GET    | `/api/config/objects`                 | 列出所有项目             |
| GET    | `/api/config/objects/:id`             | 单个项目详情             |
| POST   | `/api/config/objects`                 | 创建项目                 |
| PUT    | `/api/config/objects/:id`             | 更新项目                 |
| DELETE | `/api/config/objects/:id`             | 删除项目（级联删表规则） |
| POST   | `/api/config/objects/test-connection` | 测试数据库连接           |
| GET    | `/api/config/objects/:id/tables`      | 某项目下所有表规则       |
| POST   | `/api/config/objects/:id/tables`      | 创建表规则               |
| PUT    | `/api/config/objects/tables/:ruleId`  | 更新表规则               |
| DELETE | `/api/config/objects/tables/:ruleId`  | 删除表规则               |
| GET    | `/api/config/query-templates`         | 查询模板列表             |
| POST   | `/api/config/query-templates`         | 创建模板                 |
| PUT    | `/api/config/query-templates/:id`     | 更新模板                 |
| DELETE | `/api/config/query-templates/:id`     | 删除模板                 |

---

## 权限保护

所有 `/api/config/*` 路由在 Fastify 的 auth-context 插件之后注册，**需要有效的 admin session**。具体权限模型在 admin-vue 侧实现（基于 roles + object_id 绑定）。

---

## 创建项目

```
POST /api/config/objects
Content-Type: application/json
```

### 请求体

```json
{
  "name": "my_project",
  "description": "我的业务项目",
  "db_type": "sqlite",
  "db_path": "data/demo/my_project.db",
  "auth_required": 1,
  "enabled": 1,
  "cors_origins": "https://admin.example.com,https://app.example.com",
  "cors_methods": "GET,POST,PUT,DELETE",
  "custom_sql_enabled": 0,
  "debug": 0,
  "allow_upload_file": 0,
  "allow_download_file": 0,
  "allow_delete_file": 0,
  "allow_list_file": 1
}
```

### 必填 vs 可选

| 字段                 | 必填         | 说明                                  |
| -------------------- | ------------ | ------------------------------------- |
| `name`               | ✅           | 唯一项目名，不能是保留名              |
| `db_type`            | ✅           | `sqlite` / `mysql` / `postgres`       |
| `db_path` / `db_url` | ✅（二选一） | SQLite 用 db_path，MySQL/PG 用 db_url |
| `description`        | ❌           | 项目描述                              |
| `cors_origins`       | ❌           | NULL 时默认 `"*"`                     |
| `cors_methods`       | ❌           | NULL 时默认全部                       |
| `auth_required`      | ❌           | 默认 0                                |
| `enabled`            | ❌           | 默认 1                                |
| `debug`              | ❌           | 默认 0                                |
| 四个 `allow_*_file`  | ❌           | 默认值（见配置参考）                  |

### 保留项目名

以下名称冲突（和静态路由段重叠），禁止使用：

| 保留名   | 冲突路由        |
| -------- | --------------- |
| `config` | `/api/config/*` |
| `auth`   | `/api/auth/*`   |
| `users`  | `/api/users/*`  |
| `custom` | `/api/custom/*` |
| `files`  | `/api/files/*`  |

### 创建后自动完成

1. app.db 中 INSERT object 表
2. 注册新数据源（mysql/pg 连接验证、sqlite 文件自动创建）
3. 如果配置了 enabled=1，后续 API 请求立即生效

---

## 更新项目

```
PUT /api/config/objects/:id
Content-Type: application/json
```

### 特点

- **全部字段可选**（COALESCE 模式）：只传要改的字段，不传的保持原值
- `name` 字段**不可更新**（路径段固定）
- `db_type` **不可更新**（切换类型需要删了重建）

### 示例（只改权限开关）

```json
{
  "enabled": 0,
  "allow_list_file": 0
}
```

### 效果

项目立即停用。所有 API 请求返回 `403 项目 "my_project" 已被禁用`。

---

## 测试连接

```
POST /api/config/objects/test-connection
Content-Type: application/json
```

### 请求体

和创建项目的 body 一样（包含 db_type + db_path/db_url）。

### 返回

**成功**：

```json
{ "ok": true, "latencyMs": 12 }
```

**失败**：

```json
{
  "ok": false,
  "error": "连接被拒绝，目标主机 192.168.1.100:3306 不可达"
}
```

### 覆盖场景

| db_type  | 测试内容                                    |
| -------- | ------------------------------------------- |
| sqlite   | 路径是否存在 + 能否打开（不存在时尝试创建） |
| mysql    | TCP 连接 + SELECT 1                         |
| postgres | TCP 连接 + SELECT 1                         |

---

## 表规则管理

### 创建规则

```
POST /api/config/objects/:id/tables
Content-Type: application/json
```

```json
{
  "table_name": "orders",
  "blocked": 0,
  "allow_select": 1,
  "allow_insert": 1,
  "allow_update": 1,
  "allow_delete": 0,
  "allow_batch_insert": 1,
  "allow_batch_update": 1,
  "allow_batch_delete": 0
}
```

### 规则设计理念（白名单模式）

**必须显式配置每张表才能访问**：

```
object_table 无规则 → 所有通用 CRUD API → 403
object_table 有规则但 allow_select=0 → GET /api/:object/:table → 403
object_table 有规则且 allow_select=1 → ✅ 通过
```

这样做的好处：

1. **默认安全**：项目创建后，新表**自动全部禁用**，管理员需要显式开权限
2. **细粒度**：可以只给团队写权限不给删除权限，或者只查不让改
3. **批量例外**：batch 操作单独控制（默认 1），便于和单行操作区分

---

## 查询模板

```
GET /api/config/query-templates
POST /api/config/query-templates
PUT /api/config/query-templates/:id
DELETE /api/config/query-templates/:id
```

模板用于 `POST /api/custom/:object` 调用自定义 SQL。设计约束：

| 约束        | 说明                                |
| ----------- | ----------------------------------- |
| SELECT-only | 禁止 INSERT / UPDATE / DELETE / DDL |
| 参数化      | 只允许 `?` 占位符，不能拼接         |
| 行数封顶    | 1000 行上限                         |
| 超时        | 5000ms                              |

---

## 响应信封统一

```json
{
  "id": 5,
  "name": "my_project",
  "db_type": "sqlite",
  ...
}
```

配置管理 API 的返回体**直接是对象**，**没有**通用 CRUD 的 `{ data: ... }` 信封 — 因为管理后台是内部客户端，不需要解包层。
