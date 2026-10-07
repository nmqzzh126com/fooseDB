# fooseDB api

> 一个**零代码**的通用 CRUD 接口引擎 + 可视化配置管理后台 + 前端 SDK 测试示例。后端本身不硬编码任何业务表，所有数据源、连接串、表级权限都通过管理后台动态配置，运行时从 SQLite 配置库读取。目前已适配 SQLite、MySQL、PostgreSQL 数据源,其他数据库驱动正在开发中
> [查看在线使用文档](http://fastify_api_doc.nmyjs.cn/)

即将发布在线演示，敬请期待。

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

## 📜 License

MIT
