---
sidebar_position: 1
slug: "/"
title: "简介"
description: "FoosDB — 零代码通用 CRUD 接口引擎，基于 Fastify + TypeScript，支持 SQLite/MySQL/PostgreSQL 多数据源"
---

# FoosDB

> 零代码通用 CRUD 接口引擎 + 可视化配置管理后台 + TypeScript 前端 SDK。后端本身不硬编码任何业务表，所有数据源、连接串、表级权限都通过管理后台动态配置，运行时从配置库读取。

---

## ✨ 核心特性

- 🎯 **零代码 CRUD** — `/api/:object/:table` 统一路径访问任意数据源的任意表
- 🔌 **多数据源** — SQLite（内置）/ MySQL（已实现）/ PostgreSQL（驱动已就绪）
- 🔐 **表级权限** — 每张表独立控制 `select / insert / update / delete / batch_*` 操作
- 🔑 **完整鉴权** — JWT 双 Token（access 2h + refresh 7d）+ 客户端指纹 + 代次强制注销
- 🛡️ **安全防护** — bcrypt 密码哈希、refresh token 盗用检测、配置表保护
- 🌐 **动态 CORS** — 每个项目独立配置跨域来源
- 🧩 **自动 JOIN** — 基于外键关系自动拼接关联查询
- 📊 **分页 / 过滤 / 排序** — Directus 风格查询参数，白名单防注入
- 📁 **文件管理** — 内置上传/下载/列表/删除，四档权限独立控制
- ⚡ **Redis 缓存** — KV 查询缓存，未安装自动降级为 Stub
- 📦 **TypeScript SDK** — 开箱即用，composable 式 API，时间戳自动注入

---

## 🏗️ 项目结构

```
pure-admin-fastify/
├── api-fastify/          ★ Node.js + Fastify 后端接口服务（端口 8858）
│   ├── src/
│   │   ├── main.ts       入口：加载 .env → 注册数据源 → 插件 → 路由
│   │   ├── db.ts         配置库单例（app.db 路径硬编码、WAL 初始化、种子数据）
│   │   ├── routes/       v1/（auth/generic/roles/users/custom）+ config + admin + system
│   │   ├── services/     auth / config / generic / custom-sql
│   │   ├── datasources/  SQLite / MySQL / PostgreSQL 实现 + 注册中心
│   │   └── plugins/      auth-context / cors / ratelimit / debug
│   ├── sdk/              ★ @fooseDB/sdk — TypeScript SDK（被 admin-vue 直接引用）
│   └── data/app.db       配置库（SQLite，固定路径）
│
├── admin-vue/            ★ Vue 3 接口配置管理后台（端口 8848+）
│   └── src/
│       ├── views/        项目配置 / 表规则 / 用户角色 / 接口测试
│       └── api/demo/     通用 composable 工厂 defineFooseTable 示例
│
└── docs/                 ★ 本文档目录（可直接放入 Docusaurus）
```

---

## 🔄 三者协作关系

```
┌─────────────────────────────────────────────────────┐
│                    请求到达                          │
└──────────────────────┬──────────────────────────────┘
                       ▼
         ┌───────────────────────────┐
         │      api-fastify         │
         │   (Fastify, :8858)       │
         └────────────┬──────────────┘
                      │
        ┌─────────────┴──────────────┐
        │                            │
        ▼                            ▼
┌─────────────┐              ┌──────────────────────┐
│  admin-vue  │              │   业务前端 / SDK      │
│ (管理后台)  │              │  (@fooseDB/sdk)       │
└──────┬──────┘              └──────────┬───────────┘
       │                                │
       ▼                                ▼
┌─────────────────────────────────────────────────────┐
│                  app.db（配置库）                      │
│  object（项目）│ object_table（表规则）│ users/roles │
└──────────────────────┬──────────────────────────────┘
                       │ object.db_path / db_url
                       ▼
         ┌───────────────────────────┐
         │   业务数据库（可选）        │
         │ SQLite / MySQL / Postgres │
         └───────────────────────────┘
```

---

## 🚦 通用 API 核心链路

```
GET /api/:object/:table?page=1&pageSize=10
  │
  ├─ ① 解析 object → 查 app.db.object 表
  │     ├─ 不存在 → 404
  │     ├─ enabled=0 → 403
  │     └─ 命中配置保护表（object/object_table/users）→ 403
  │
  ├─ ② 查 object_table 获取表级权限规则
  │     ├─ 无规则 → 403（白名单模式）
  │     ├─ blocked=1 → 403
  │     └─ allow_select=0 → 403
  │
  ├─ ③ object.auth_required=1 → 校验 JWT + 客户端指纹
  │
  ├─ ④ datasource.getDs(object.name) → 拿到对应连接
  ├─ ⑤ schema.ts → 自动推导表结构（10 分钟缓存）
  ├─ ⑥ filter.ts → 解析 Directus 风格查询参数（白名单防注入）
  ├─ ⑦ join.ts → 探测外键并自动 JOIN
  └─ ⑧ 执行 SQL → 返回 JSON
```

---

## 🛠️ 技术栈

| 组件         | 技术                                             |
| ------------ | ------------------------------------------------ |
| 后端运行时   | Node.js ≥ 22（TypeScript，tsx watch 开发）       |
| HTTP 框架    | Fastify 5                                        |
| 配置库       | better-sqlite3（SQLite WAL 模式）                |
| 业务库       | mysql2 / pg                                      |
| 缓存         | ioredis（未启用自动降级为 Stub）                 |
| 认证         | JWT + bcrypt                                     |
| 参数校验     | Zod                                              |
| SDK 构建     | tsup                                             |
| 前端管理后台 | Vue 3 + Vite + Element Plus + Pinia + TypeScript |
| 包管理       | pnpm ≥ 11                                        |

---

## 📖 文档导航

| 模块                                           | 说明                                   |
| ---------------------------------------------- | -------------------------------------- |
| [快速开始](./getting-started/installation.md)  | 环境要求、安装步骤、服务启动           |
| [配置参考](./getting-started/configuration.md) | 环境变量、数据库权限、项目配置         |
| [通用 CRUD API](./api/generic-crud.md)         | `/api/:object/:table` 系列 11 个端点   |
| [文件操作 API](./api/file-operations.md)       | 上传 / 下载 / 列表 / 删除 / 元数据查询 |
| [认证 API](./api/auth.md)                      | 登录 / 登出 / 刷新 / 当前用户          |
| [配置管理 API](./api/admin-config.md)          | 项目 CRUD / 表规则 CRUD / 连接测试     |
| [SDK 参考](./sdk/reference.md)                 | @fooseDB/sdk 完整方法签名              |

---

## 📜 License

MIT
