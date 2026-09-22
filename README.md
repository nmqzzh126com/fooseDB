# pure-admin-fastify

> 一个**零代码**的通用 CRUD 接口引擎 + 可视化配置管理后台 + 前端 SDK 测试示例。后端本身不硬编码任何业务表，所有数据源、连接串、表级权限都通过管理后台动态配置，运行时从 SQLite 配置库读取。目前已适配 SQLite、MySQL、PostgreSQL 数据源,其他数据库驱动正在开发中,敬请期待(最近更新2026-09-22)......

## ✨ 特性

- 🎯 **零代码 CRUD** — 通过 `/api/:object/:table` 统一路径访问任意数据源的任意表
- 🔌 **多数据源** — SQLite（内置）/ MySQL（已实现）/ PostgreSQL（驱动已就绪，待启用）
- 🔐 **表级权限** — 每张表独立控制 `select / insert / update / delete / batch_*` 操作
- 🔑 **完整鉴权** — JWT 双 Token（access 2h + refresh 7d）+ 客户端指纹 + 代次强制注销 + 登录限流
- 🛡️ **安全防护** — bcrypt 密码哈希、refresh token 盗用检测、自定义 SQL 安全审计、配置表保护
- 🌐 **动态 CORS** — 每个项目独立配置跨域来源
- 🧩 **自动 JOIN** — 基于外键关系自动拼接关联查询
- 📊 **分页 / 过滤 / 排序** — Directus 风格查询参数，支持白名单防注入
- ⚡ **Redis 缓存** — KV 查询缓存 / 分布式锁，未安装自动降级为 Stub

## 🏗️ 架构

```
pure-admin-fastify/                    (Monorepo 根目录)
├── api-fastify/                       ★ Node.js + Fastify 后端接口服务
│   ├── src/
│   │   ├── main.ts                    入口：加载 .env → 注册数据源 → 插件 → 路由 → 监听
│   │   ├── db.ts                      配置库单例（app.db 路径硬编码、WAL 初始化、种子数据）
│   │   ├── config/env.ts              类型化 .env 解析
│   │   ├── datasources/               数据源注册中心（registry）+ SQLite / MySQL / PG 实现
│   │   ├── caches/                    Redis 缓存注册 + 类型定义
│   │   ├── plugins/                   CORS / auth-context / ratelimit
│   │   ├── routes/                    v1/（auth/generic/roles/users/custom） + config + admin + system
│   │   ├── services/                  auth.service（登录/JWT/refresh 轮换+事务） + config.service
│   │   ├── utils/                     schema（自动推表结构）/ filter（Directus 语法解析）/ join / errors
│   │   └── schemas/                   Zod 校验（auth / config / users）
│   └── data/app.db                    ★ 固定配置库（SQLite），存储 object / object_table / users 等
│
├── admin-vue/                         ★ Vue 3 接口配置管理后台（基于 pure-admin 模板）
│   ├── src/api/foosePureAdmin.ts      管理端 API：登录 / 项目 CRUD / 表规则 CRUD / 用户角色
│   ├── src/utils/http/index.ts        HTTP 客户端：统一 X-Client-Id 指纹 + Bearer + 自动 refresh
│   ├── src/views/object/index.vue     接口管理主页面（项目列表 + 表规则配置）
│   ├── src/views/object/test_api.vue  接口可视化测试页
│   └── vite.config.ts                 自动读 api-fastify/.env 的 ADMIN_PATH；proxy /api → :8858
│
├── client/                            ★ Vue 3 前端业务测试 / FoosDB SDK 示例
│   ├── src/api/foose_db.ts            通用 CRUD SDK：list / getOne / insert / update / delete
│   ├── src/utils/foose_db_http/       FoosDB 专用 HTTP 客户端（baseURL = VITE_FOOSE_DB_BASE_URL）
│   └── src/views/test_api/            产品模块示例：index / edit / edit_type / edit_label
│
├── tools/redis/                       Windows Redis 5.0.14.1 便携版
└── my_test/test.http                  HTTP 接口测试用例
```

### 三者协作关系

```
                        ┌─────────────────────┐
                        │    api-fastify      │
                        │  (Node + Fastify)   │
                        │    Port: 8858       │
                        └─────────┬───────────┘
                                  │
                    HTTP（/api/*, /uploads, /admin）
                    ┌─────────────┴───────────────┐
                    │                               │
        ┌───────────▼───────────┐        ┌─────────▼──────────┐
        │      admin-vue        │        │      client        │
        │  配置管理后台 (Vite)   │        │  业务前端 (Vite)    │
        │   Port: 8848          │        │  Port: 8849        │
        │   proxy → 8858        │        │  baseURL=8858      │
        └───────────┬───────────┘        └─────────┬──────────┘
                    │                               │
                    │  读写 app.db（配置库）          │  读/写业务数据库
                    ▼                               ▼
         ┌────────────────────────────────────────────────────┐
         │                  SQLite app.db                     │
         │  ┌─────────┐  ┌──────────────┐  ┌─────────────┐  │
         │  │  object │  │ object_table │  │  users/roles│  │
         │  └─────────┘  └──────────────┘  └─────────────┘  │
         └────────────────────────┬─────────────────────────┘
                                  │ object.db_path / db_url
                                  ▼
                  ┌─────────────────────────────┐
                  │     业务数据库（可选）         │
                  │  SQLite / MySQL / PostgreSQL  │
                  │  (demo.db / orders.db / ...)  │
                  └─────────────────────────────┘
```

### 通用 API 核心链路

```
请求 /api/:object/:table
  │
  ├─ 1. 解析 object → 查 app.db.object 表
  │     ├─ object.enabled === 0 → 403
  │     ├─ object 不存在 → 404
  │     └─ CONFIG_GUARDED_TABLES（object/object_table/users 等）→ 403
  │
  ├─ 2. 查 object_table 获取表级权限规则
  │     ├─ 无规则 → 403（白名单模式）
  │     ├─ blocked=1 → 403
  │     └─ allow_<op>=0 → 403
  │
  ├─ 3. object.auth_required=1 → 校验 JWT + 客户端指纹
  │
  ├─ 4. datasource.getDs(object.name) → 拿到对应连接
  ├─ 5. schema.ts → 自动推导表结构（带缓存）
  ├─ 6. filter.ts → 解析 Directus 风格查询参数（白名单防注入）
  ├─ 7. join.ts → 探测外键并自动 JOIN
  └─ 8. 执行 SQL → 返回 JSON
```

## 🛠️ 技术栈

| 组件                   | 技术                                             |
| ---------------------- | ------------------------------------------------ |
| 后端运行时             | Node.js（TypeScript，tsx watch 开发）            |
| HTTP 框架              | Fastify                                          |
| 配置库                 | better-sqlite3（SQLite）                         |
| 业务库                 | mysql2 / pg                                      |
| 缓存                   | ioredis（未启用自动降级为 Stub）                 |
| 认证                   | JWT（jsonwebtoken）+ bcrypt                      |
| 校验                   | Zod                                              |
| 前端（admin / client） | Vue 3 + Vite + TypeScript + Element Plus + Pinia |
| 包管理                 | pnpm                                             |

## 🚀 快速开始

### 前置条件

- Node.js >= 18
- pnpm >= 8
- （可选）Redis >= 5

### 1. 克隆并安装依赖

```bash
git clone <your-repo-url>
cd pure-admin-fastify

# 分别安装三个子项目的依赖（monorepo 无根 package.json）
cd api-fastify   && pnpm install
cd ../admin-vue  && pnpm install
cd ../client     && pnpm install
```

### 2. 启动后端

```bash
cd api-fastify
pnpm dev
# http://localhost:8858
```

首次启动会自动：

- 创建 `data/app.db`（SQLite，WAL journal mode）
- 建表 + 种子数据（内置 sqlite_app 项目 + demo 业务库示例）
- 注册所有 object 表中配置的数据源
- Redis 未启动时自动降级为 Stub

### 3. 启动管理后台

```bash
cd admin-vue
pnpm dev
# http://localhost:8848/admin（实际端口会自动跳过被占用端口）
```

开发模式下 `vite.config.ts` 会**自动读取 api-fastify/.env 的 ADMIN_PATH**，并 proxy `/api` 和 `/uploads` 到 `http://localhost:8858`。

默认登录账号（在 api-fastify/.env 配置）：

```
用户名: admin
密码: admin123456
```

### 4. 启动前端测试

```bash
cd client
pnpm dev
# http://localhost:8849（避免与 admin-vue 冲突）
```

client 通过 `VITE_FOOSE_DB_BASE_URL` 直连后端，不走 Vite proxy。

### 三端端口总览

| 服务        | 默认端口 | 说明                          |
| ----------- | -------- | ----------------------------- |
| api-fastify | 8858     | 后端 HTTP                     |
| admin-vue   | 8848     | Vite proxy → 8858             |
| client      | 8849     | VITE_FOOSE_DB_BASE_URL → 8858 |

## 📖 使用流程

```
1. 管理员启动 api-fastify → 自动初始化 app.db（内置 sqlite_app 项目）
2. 管理员启动 admin-vue → 登录（admin / admin123456）
3. 创建新项目 "my_project" → 配置 MySQL 连接串 / 选 sqlite
4. 为 my_project 的 orders 表配置 allow_select=true / allow_insert=true ...
5. 前端用 foose_db SDK 调用：
   fooseDbList({ object: "my_project", table: "orders", page: 1, pageSize: 10 })
6. 后端解析 → 查配置库 → 校验权限 → 连业务库 → 返回数据
```

## 🔐 安全机制

| 机制         | 说明                                                          |
| ------------ | ------------------------------------------------------------- |
| 密码         | bcrypt 哈希（cost=10，支持 4~31 可调），改密/重置自动生效     |
| Token        | accessToken（2h）+ refreshToken（7d），refresh 自动轮换       |
| 盗用检测     | 同一 refresh family 重复使用 → 整 family 作废                 |
| 客户端指纹   | JWT 绑定 X-Client-Id（canvas 指纹），换设备必须重登           |
| 代次强制注销 | 改密后 token_version 自增，旧 token 立即失效                  |
| 登录限流     | IP 维度，默认 30 次 / 60s（Redis 启用时生效）                 |
| 配置表保护   | object / object_table / users / roles 等禁止通过通用 API 访问 |
| CORS 防护    | 动态读取 object.cors_origins，未配置默认兜底 `"*"`            |
| SQL 注入     | filter 白名单语法 + 自定义 SQL 参数化 + 行数封顶 + 超时       |

## 📁 配置库核心表

| 表名                  | 作用                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `object`              | 项目定义：name / db_type / db_url / db_path / cors_origins / auth_required / enabled |
| `object_table`        | 表级权限：object*id → table_name + allow_select/insert/update/delete + batch*\*      |
| `users`               | 管理端用户（object_id=-1 管理员，>=1 绑定项目）                                      |
| `roles` + `role_user` | 角色多对多绑定                                                                       |
| `query_template`      | 自定义 SQL 模板（SELECT-only、参数化、行数封顶、超时）                               |
| `custom_query_log`    | 自定义 SQL 执行审计                                                                  |
| `refresh_tokens`      | refresh token 代次轮换 + 盗用检测                                                    |

## 🧪 测试

后端使用 vitest + supertest：

```bash
cd api-fastify
pnpm test
```

测试覆盖：auth / config / cors / custom-sql / join / whitelist / admin-db 等模块。

## ⚙️ 生产部署

### 后端

```bash
cd api-fastify
pnpm build          # 编译 TS → dist/
pnpm start          # 生产启动
# 或用 pm2
pm2 start ecosystem.config.cjs
```

### 前端（admin-vue / client）

```bash
cd admin-vue && pnpm build
cd client     && pnpm build
# dist/ 目录部署到任意静态服务器（Nginx / Caddy / Cloudflare Pages）
```

### 环境变量速查（api-fastify/.env）

| 变量                           | 默认                   | 说明                                  |
| ------------------------------ | ---------------------- | ------------------------------------- |
| `PORT`                         | 8858                   | HTTP 端口                             |
| `HOST`                         | 0.0.0.0                | 监听地址                              |
| `ADMIN_PATH`                   | /admin                 | 管理后台入口路径                      |
| `ADMIN_USERNAME`               | admin                  | 管理员账号                            |
| `ADMIN_PASSWORD`               | admin123456            | 管理员密码（明文或 bcrypt `$2` 开头） |
| `JWT_SECRET`                   | dev-secret-...         | JWT 签名密钥（**生产必须更换**）      |
| `ACCESS_TOKEN_TTL_SEC`         | 7200                   | Access token 有效期（秒）             |
| `REFRESH_TOKEN_TTL_SEC`        | 604800                 | Refresh token 有效期（秒）            |
| `REDIS_CACHE_DEFAULT__ENABLED` | false                  | Redis 开关                            |
| `REDIS_CACHE_DEFAULT__URL`     | redis://127.0.0.1:6379 | Redis 地址                            |

## 📜 License

MIT
