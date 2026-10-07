---
sidebar_position: 2
title: "配置参考"
slug: "/getting-started/configuration"
description: "环境变量速查、object 表字段说明、object_table 表规则说明、文件权限设计"
---

# 配置参考

## 环境变量（api-fastify/.env）

### 服务基础

| 变量             | 默认值        | 类型   | 说明                                            |
| ---------------- | ------------- | ------ | ----------------------------------------------- |
| `PORT`           | `8858`        | number | HTTP 监听端口                                   |
| `HOST`           | `0.0.0.0`     | string | 监听地址                                        |
| `ADMIN_PATH`     | `/admin`      | string | 管理后台入口路径                                |
| `ADMIN_USERNAME` | `admin`       | string | 内置管理员账号                                  |
| `ADMIN_PASSWORD` | `admin123456` | string | 管理员密码。明文或 bcrypt `$2` 开头（自动识别） |

### JWT 认证

| 变量                    | 默认值                            | 类型   | 说明                           |
| ----------------------- | --------------------------------- | ------ | ------------------------------ |
| `JWT_SECRET`            | `dev-secret-change-in-production` | string | **生产必须更换**，签名所有 JWT |
| `ACCESS_TOKEN_TTL_SEC`  | `7200`（2h）                      | number | Access token 有效期（秒）      |
| `REFRESH_TOKEN_TTL_SEC` | `604800`（7d）                    | number | Refresh token 有效期（秒）     |

### Redis 缓存

| 变量                           | 默认值                   | 类型    | 说明                            |
| ------------------------------ | ------------------------ | ------- | ------------------------------- |
| `REDIS_CACHE_DEFAULT__ENABLED` | `false`                  | boolean | Redis 开关，false 时降级为 Stub |
| `REDIS_CACHE_DEFAULT__URL`     | `redis://127.0.0.1:6379` | string  | Redis 连接串                    |

### 文件操作

| 变量                   | 默认值                          | 类型   | 说明                         |
| ---------------------- | ------------------------------- | ------ | ---------------------------- |
| `UPLOAD_FILES_COUNT`   | `10`                            | number | 每次最多上传文件数           |
| `UPLOAD_FILE_SIZE`     | `5120`                          | number | 单文件最大尺寸（KB）         |
| `UPLOAD_FILES_TYPE`    | `jpg,jpeg,png,gif,pdf,doc,docx` | string | 文件扩展名白名单（逗号分隔） |
| `DOWNLOAD_FILES_COUNT` | `10`                            | number | 每次同时下载文件数           |
| `DELETE_FILES_COUNT`   | `10`                            | number | 每次同时删除文件数           |
| `FILES_PAGE_SIZE`      | `20`                            | number | 文件列表默认分页大小         |

---

## object 表字段（配置库）

object 表定义了**一个独立的数据源接入项目**：

| 字段                  | 类型          | 默认值                 | 说明                                                                     |
| --------------------- | ------------- | ---------------------- | ------------------------------------------------------------------------ |
| `id`                  | INTEGER PK    | auto                   |                                                                          |
| `name`                | TEXT UNIQUE   | —                      | 项目名（URL 第一段）。**保留名**：config / auth / users / custom / files |
| `description`         | TEXT          | NULL                   | 项目描述                                                                 |
| `db_type`             | TEXT NOT NULL | —                      | 数据源类型：`sqlite` / `mysql` / `postgres`                              |
| `db_url`              | TEXT          | NULL                   | MySQL/PostgreSQL 连接串，如 `mysql://user:pass@127.0.0.1:3306/db`        |
| `db_path`             | TEXT          | NULL                   | SQLite 文件路径（相对路径会自动基于项目根目录解析）                      |
| `cors_origins`        | TEXT          | NULL                   | 逗号分隔跨域来源，`NULL` 表示 `"*"`                                      |
| `cors_methods`        | TEXT          | NULL                   | 逗号分隔 HTTP 方法，`NULL` 表示全部                                      |
| `custom_sql_enabled`  | INTEGER       | `0`                    | 是否允许执行自定义 SQL（`/api/custom/:object`）                          |
| `auth_required`       | INTEGER       | `0`                    | 是否强制 JWT 认证后才能访问该项目的 API                                  |
| `enabled`             | INTEGER       | `1`                    | 项目总开关，置 0 则全部 API 返回 403                                     |
| `debug`               | INTEGER       | `0`                    | 调试日志开关（Redis 启用时存储最近 1000 条请求/响应）                    |
| `allow_upload_file`   | INTEGER       | **`0`**                | 文件上传权限                                                             |
| `allow_download_file` | INTEGER       | **`0`**                | 文件下载权限                                                             |
| `allow_delete_file`   | INTEGER       | **`0`**                | 文件删除权限                                                             |
| `allow_list_file`     | INTEGER       | **`1`**                | 文件列表/元数据查询权限 🆕                                               |
| `created_at`          | INTEGER       | `strftime('%s','now')` | 创建时 Unix 时间戳                                                       |

---

## object_table 表字段（表级权限）

每张业务表可以独立配置权限。**白名单模式**：某张表如果没有配置 object_table 规则 → 默认全部 403：

| 字段                 | 类型                | 默认值 | 说明                                    |
| -------------------- | ------------------- | ------ | --------------------------------------- |
| `id`                 | INTEGER PK          | auto   |                                         |
| `object_id`          | INTEGER FK → object | —      | 所属项目                                |
| `table_name`         | TEXT NOT NULL       | —      | 业务表名（区分大小写）                  |
| `blocked`            | INTEGER             | `0`    | 整体封杀，置 1 则该表所有操作 403       |
| `allow_select`       | INTEGER             | `0`    | 允许 list / get / join 查询             |
| `allow_insert`       | INTEGER             | `0`    | 允许 create 单行                        |
| `allow_update`       | INTEGER             | `0`    | 允许 update 单行 + inc-dec              |
| `allow_delete`       | INTEGER             | `0`    | 允许 delete 单行                        |
| `allow_batch_insert` | INTEGER             | `1`    | 允许 batch-create                       |
| `allow_batch_update` | INTEGER             | `1`    | 允许 batch-update                       |
| `allow_batch_delete` | INTEGER             | `1`    | 允许 batch-delete + batch-delete-filter |

### inc-dec 操作的权限归属

原子自增/自减本质是 update 语义，所以检查的是 `allow_update`（不是 `allow_batch_update`）。

---

## 文件权限设计

四个独立字段（object 表），三档默认值体现安全优先级：

| 字段                  | 默认  | 理由                             |
| --------------------- | ----- | -------------------------------- |
| `allow_upload_file`   | **0** | 写数据是敏感操作，应显式开启     |
| `allow_download_file` | **0** | 拿文件实体是敏感操作，应显式开启 |
| `allow_delete_file`   | **0** | 破坏性操作，应显式开启           |
| `allow_list_file`     | **1** | 浏览目录是基础需求，默认应允许   |

### 路由 → 权限映射

| HTTP   | 路由                                      | 权限字段              |
| ------ | ----------------------------------------- | --------------------- |
| POST   | `/api/files/:object/:foldername`          | `allow_upload_file`   |
| GET    | `/api/files/:object/info/:file_id`        | `allow_list_file`     |
| GET    | `/api/files/:object/:file_id`             | `allow_download_file` |
| DELETE | `/api/files/:object/:foldername/:file_id` | `allow_delete_file`   |
| GET    | `/api/files/:object/:foldername/:page`    | `allow_list_file`     |

### 权限校验链

```
请求 → object 存在 (404)
     → object.enabled=1 (403)
     → allow_*_file=1 (403)
     → auth_required=1 时校验 JWT + 客户端指纹 (401)
     → 用户绑定校验 (403)
     → 执行
```

---

## 配置库受保护表

以下表**禁止通过通用 CRUD API 访问**（CONFIG_GUARDED_TABLES），防止绕过管理后台直接修改：

| 表名           | 保护原因                                                 |
| -------------- | -------------------------------------------------------- |
| `object`       | 项目定义，通过 `/api/config/objects` 管理                |
| `object_table` | 表规则，通过 `/api/config/objects/:id/tables` 管理       |
| `users`        | 管理员账户，通过 `/api/users/*` 管理（也只允许特定操作） |

> 尝试用 `GET /api/config/object`（object 也是保留路径段）会直接 404。

---

## 数据源类型说明

### SQLite

```text
db_type: sqlite
db_path: data/demo/my_project.db
```

- `db_path` 是相对于 `api-fastify/` 根目录的相对路径
- 自动创建 WAL journal mode
- 示例：`data/demo/sqlite_demo.db`

### MySQL

```text
db_type: mysql
db_url: mysql://user:password@127.0.0.1:3306/db_name
```

### PostgreSQL

```text
db_type: postgres
db_url: postgres://user:password@127.0.0.1:5432/db_name
```

---

## 文件存储路径

上传的文件物理位置：

```
api-fastify/uploads/<object>/<foldername>/<uuid>.<ext>
```

- `object` = 项目名
- `foldername` = 前端传入的文件夹路径
- `uuid` = 后端生成的随机名（防冲突 + 防路径遍历）
- `ext` = 扩展名（从白名单校验过）

**foldername 分隔符**：当前使用 `-` 分隔多层（如 `docs-images` 表示两层 `docs/images`）。⚠️ 未来版本将迁移到 `__` 双下划线分隔，届时 `-` 可以作为业务字符保留在单层文件夹名中。

---

## 自动数据库迁移

api-fastify 每次启动时 `db.ts` 会检测 schema 版本并执行 ALTER TABLE：

- 使用 `SELECT column_name FROM pragma_table_info('object')` 探测列是否存在
- 新列加 `ALTER TABLE object ADD COLUMN new_col INTEGER NOT NULL DEFAULT ...`
- 零停机：直接启动，不影响已有数据
- 字段顺序不保证（SQLite ALTER TABLE 追加列到末尾）
