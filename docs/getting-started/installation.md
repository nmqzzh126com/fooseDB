---
sidebar_position: 1
title: "安装部署"
slug: "/getting-started/installation"
description: "环境要求、安装步骤、开发模式、生产部署"
---

# 安装部署

## 前置条件

| 依赖                       | 最低版本  | 说明                            |
| -------------------------- | --------- | ------------------------------- |
| Node.js                    | ≥ 22.22.1 | admin-vue 的 engines 强制       |
| pnpm                       | ≥ 11      | 项目使用 `only-allow pnpm` 锁定 |
| （强烈推荐）Redis          | ≥ 5       | 未安装时缓存自动降级为 Stub     |
| （根据需求可选）MySQL      | ≥ 5.7     | MySQL 业务数据源                |
| （根据需求可选）PostgreSQL | ≥ 12      | PostgreSQL 业务数据源           |

> **包管理器锁定**：统一用 pnpm。

---

## 目录结构

```
pure-admin-fastify/
├── api-fastify/       后端（Fastify）+ SDK
├── admin-vue/         管理后台（Vue 3）
├── tools/redis/       Windows 便携 Redis（开发时使用）
└── docs/              本文档
```

两个核心子项目**没有根 package.json**，各自独立维护依赖。

---

## 开发模式（推荐）

### 第一步 — 克隆并安装

```bash
git clone https://github.com/nmqzzh126com/fooseDB.git
cd fooseDB

# 后端 + SDK
cd api-fastify
pnpm install

# 管理后台
cd ../admin-vue
pnpm install
```

### 第二步 — 启动后端

```bash
cd api-fastify
pnpm dev
# → http://localhost:8858
```

首次启动自动完成：

1. 创建 `api-fastify/data/app.db`（SQLite，WAL journal mode）
2. 建表 + 种子数据（内置 `sqlite_demo` 项目 + demo 业务库示例）
3. 注册所有 object 表中配置的数据源
4. Redis 未启动时自动降级为 Stub
5. 管理后台入口注册到 `/admin`（ADMIN_PATH 可配置）

### 第三步 — 启动管理后台

修改 `admin-vue/.env.production`，将 `VITE_FOOSE_DB_BASE_URL` 改为 `当前服务器的接口地址或域名`,否则登录后台无法正常演示。

```bash
cd admin-vue
pnpm dev
# → http://localhost:8859/admin（端口被占用时自动递增）
```

Vite 自动读 `api-fastify/.env` 的 `ADMIN_PATH`，并 proxy `/api` 和 `/uploads` 到 `http://localhost:8858`。

默认登录账号（在 `.env` 配置）：

| 字段   | 默认值                                     |
| ------ | ------------------------------------------ |
| 用户名 | `admin`                                    |
| 密码   | `admin123456`（可明文或 bcrypt `$2` 开头） |

### 第四步 — （可选）启动 Redis

Windows 便携版：

```bash
# 在 tools/redis/ 目录下
redis-server redis.windows.conf
# 或双击 start-redis.bat
```

---

## 端口总览

| 服务        | 默认端口                     | 说明                     |
| ----------- | ---------------------------- | ------------------------ |
| api-fastify | **8858**                     | 后端 HTTP（.env 里可改） |
| admin-vue   | **8859**（被占用时自动递增） | Vite proxy → 8859        |
| Redis       | **6379**（可选）             | 缓存服务                 |
| MySQL       | **3306**（可选）             | 业务数据源               |
| PostgreSQL  | **5432**（可选）             | 业务数据源               |

---

## 生产部署

### 方式一：Node.js + PM2

```bash
# ① 编译后端
cd api-fastify
pnpm build
# → dist/main.js（TypeScript 编译产物）

# ② 编译管理后台（会被 api-fastify 打包进后端静态目录）
pnpm build:frontend
# → admin-vue/dist/ 被复制到 api-fastify/admin-vue/dist/

# ③ 用 PM2 启动
pnpm pm2:start
# 或
pm2 start ecosystem.config.cjs --only foosdb
```

PM2 常用命令：

```bash
pnpm pm2:logs     # 查看日志
pnpm pm2:restart  # 重启
pnpm pm2:monit    # 监控面板
pnpm pm2:save     # 保存当前进程列表
```

### 方式二：Node.js 直接运行

```bash
cd api-fastify
pnpm build
node dist/main.js
```

### 方式三：admin-vue 独立部署

如果你想把管理后台部署到另一个域名（如 `admin.example.com`）：

```bash
# 只编译 admin-vue
cd admin-vue
pnpm build

# dist/ 目录部署到任意静态服务器（Nginx / Caddy / Cloudflare Pages / Vercel）
```

此时后端需要**开启 CORS**：在管理后台对应的 object 项目里配置 `cors_origins = https://admin.example.com`。

---

## 环境变量

详细配置项见 [配置参考](./configuration.md)。

**生产必须改的 3 个值**：

| 变量                           | 默认                              | 风险                         |
| ------------------------------ | --------------------------------- | ---------------------------- |
| `JWT_SECRET`                   | `dev-secret-change-in-production` | 任何拿到这个值的人能伪造 JWT |
| `ADMIN_PASSWORD`               | `admin123456`                     | 管理员弱密码                 |
| `REDIS_CACHE_DEFAULT__ENABLED` | `false`                           | 生产建议开启（防限流失效）   |

---

## 常见问题

### Q: 启动后 app.db 在哪？

`api-fastify/data/app.db`。路径在 `db.ts` 中硬编码：

```typescript
function getDbPath() {
  return path.resolve(__dirname, "..", "data", "app.db");
}
```

**不可通过 .env 配置**，这是设计决策 — 配置库位置固定。

### Q: Redis 没装，启动报连接失败？

不影响。Redis 未启动时自动降级为内存 Stub（`src/caches/` 里的 registry 自动切换）。但**登录限流**（基于 Redis）会失效，生产建议开启。

### Q: Windows 上 better-sqlite3 报编译错误？

better-sqlite3 原生模块需要 node-gyp：

```bash
pnpm install -g windows-build-tools   # 或安装 Visual Studio Build Tools
cd api-fastify
pnpm rebuild better-sqlite3
```

### Q: admin-vue 和 api-fastify 在不同机器？

在 admin-vue 的 `vite.config.ts` 里修改 proxy target：

```typescript
server: {
  proxy: {
    "/api": { target: "http://api.example.com:8859", changeOrigin: true },
    "/uploads": { target: "http://api.example.com:8859", changeOrigin: true }
  }
}
```

同时在 api-fastify 对应的 object 里配置 `cors_origins`。
