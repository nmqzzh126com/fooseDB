# 将 .env DS_* 配置迁移到 object 表（per-row）

## Context

当前架构中，数据库连接信息（类型、URL/路径、CORS、自定义SQL开关）散布在 `.env` 的 `DS_*__*` 声明中，`object` 表通过 `ds_name` 引用。用户要求将这些配置移入 `object` 表，使每行项目自带完整配置：`db_type` / `db_url` / `db_path` / `cors_origins` / `cors_methods` / `custom_sql_enabled`，彻底废弃 `.env DS_*` 和全局 `CUSTOM_SQL_ENABLED`。

## 新增 object 表字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `db_type` | TEXT NOT NULL | `sqlite` / `mysql` / `postgres` |
| `db_url` | TEXT | MySQL/PG 连接串（SQLite 时为 NULL） |
| `db_path` | TEXT | SQLite 文件路径（MySQL/PG 时为 NULL） |
| `cors_origins` | TEXT | 逗号分隔 Origin 或 `*`（NULL = 不设 CORS） |
| `cors_methods` | TEXT | 逗号分隔方法（NULL = 全部方法） |
| `custom_sql_enabled` | INTEGER NOT NULL DEFAULT 0 | 0/1 |

移除字段：`ds_name`（被上述字段替代）

## 实施步骤

### 1. db.ts — schema 迁移 + 种子数据

- `initDb()` 中 `CREATE TABLE object` DDL 改为新字段集（移除 `ds_name`，加入 6 个新字段）
- 加 guarded ALTER TABLE（`SELECT db_type FROM object LIMIT 0` try/catch 模式，与现有 `token_version` 迁移一致）为已存在的数据库加列
- 一次性数据迁移：读旧 `ds_name` → 从 `process.env.DS_*` 查出 type/url/path/cors → UPDATE 填入新列 → 删除 `ds_name` 列
- 种子 INSERT 改为新字段：`sqlite_app` 行 → `db_type='sqlite', db_path=<data/app.db 绝对路径>, cors_origins='*', custom_sql_enabled=1`；`mysql_orders` 行 → `db_type='mysql', db_url=..., cors_origins=...`
- `ObjectRow` 接口（config.service.ts:43-50）同步更新

### 2. registry.ts — 动态注册/注销 API

- 新增 `registerObjectDs(row)`：根据 `db_type/db_url/db_path` 构建 Datasource → `open()` → `_store.set(row.name, ds)`，幂等
- 新增 `unregisterObjectDs(name)`：`ds.close()` + `_store.delete(name)`，幂等
- 新增 `reregisterObjectDs(row)`：先 unregister 再 register（用于 updateObject 连接参数变更）
- 新增 `bulkRegisterObjectDsFromDb()`：`SELECT name,db_type,db_url,db_path FROM object` 逐行 registerObjectDs，跳过已注册的 `sqlite_app`
- `registerAll()` 改为只注册内置 `sqlite_app`（config DB），不再从 .env 读
- registry key 从 `ds_name` 改为 `object.name`

### 3. config.service.ts — 核心 service 重写

- `ObjectRow` 接口：移除 `ds_name`，加 `db_type/db_url/db_path/cors_origins/cors_methods/custom_sql_enabled`
- `createObject(input)`：接受新字段，INSERT 后调 `await registerObjectDs(newRow)`
- `updateObject(id, input)`：接受新字段，若 `db_type/db_url/db_path` 变更则调 `await reregisterObjectDs(updatedRow)`
- `deleteObject(id)`：禁止删除 `name='sqlite_app'` 的行（保护内置 config DB），其他行 DELETE 后调 `await unregisterObjectDs(name)`
- `resolveObjectAccess()`：
  - 步骤 3 配置库自保护：`obj.name === "sqlite_app"` 替代 `obj.ds_name === "sqlite_app"`
  - 步骤 4 数据源检查：移除 `getDataSourceDecls()` 检查，改为确保 registry 有该 object 的 DS（懒注册：若 `_store` 没有则 `registerObjectDs(obj)`）
  - 返回的 `ObjectAccess.dsName` 改为 `obj.name`
- 移除 `getDataSourceDecls` import

### 4. schemas/config.schema.ts — JSON Schema 更新

- `CreateObjectSchema`：移除 `ds_name`，加 `db_type`(required, enum)、`db_url`(optional)、`db_path`(optional)、`cors_origins`(optional)、`cors_methods`(optional)、`custom_sql_enabled`(FLAG)
- `UpdateObjectSchema`：同上新字段全部 optional

### 5. routes/config/objects.ts — 路由层

- `POST`/`PUT` 路由的 body 透传新字段（schema 变更后自动生效）
- `updateObject`/`deleteObject` 改为 `await`（因 service 变 async）

### 6. custom-sql.ts — per-object 自定义 SQL 开关

- 删除 `isCustomSqlEnabled()` 函数和 `getEnv().customSqlEnabled` 引用
- `executeCustomQuery()` 中：
  - 删除全局 503 检查（行 641-643）
  - 删除 `getDataSourceDecls().some(...)` 检查（行 646-649）
  - 加 `if (obj.custom_sql_enabled !== 1) throw 503 "custom SQL is disabled for this object"`
  - `getDs(obj.ds_name)` 改为 `getDs(obj.name)`

### 7. cors.ts — per-object CORS 直读

- 删除 `buildCorsMap()`（不再从 datasource decl 读）
- `resolveDsNameFromPath()` 改为 `resolveObjectCors(url)`：直接查 `object` 表的 `cors_origins, cors_methods`
  - `/api/<object>/<table>`：`SELECT cors_origins, cors_methods FROM object WHERE name = ?`
  - `/api/custom/<tpl>`：`SELECT o.cors_origins, o.cors_methods FROM query_template t JOIN object o ON o.id=t.object_id WHERE t.name=?`
- onRequest 钩子：从 object 行实时读 CORS，无需重建 map（PUT 更新后立即生效）

### 8. query-template.service.ts — 移除 .env 检查

- `createTemplate`/`updateTemplate` 中删除 `getDataSourceDecls().some(...)` 检查
- 移除 `getDataSourceDecls` import

### 9. env.ts + datasources.ts + main.ts — 环境配置清理

- `env.ts`：删除 `collectDataSources()`、`DataSourceDecl` 接口中的 CORS 字段、`customSqlEnabled` 字段；仅保留 `sqlite_app` 内置声明（type=sqlite, path=data/app.db）
- `datasources.ts`：`getDataSourceDecls()` 只返回 `[{name:"sqlite_app", type:"sqlite", path:...}]`
- `main.ts`：启动顺序改为 `registerAll()`(仅 sqlite_app) → `bulkRegisterObjectDsFromDb()`(扫描 object 表)

### 10. 测试更新

- `test/setup-env.ts`：移除 `DS_SQLITE_APP__CORS_*`、`CUSTOM_SQL_ENABLED`、`delete DS_MYSQL_ORDERS__*`
- `test/helper-object.ts`：`createTestObject` 参数改为 `{ name, db_type?, db_path?, db_url?, cors_origins?, cors_methods?, custom_sql_enabled?, description?, auth_required? }`，默认 `db_type='sqlite', db_path=<app.db 绝对路径>, custom_sql_enabled=1`
- `test/routes/config.test.ts`：`ds_name:"sqlite_app"` → 新字段
- `test/routes/auth.test.ts`：同上（3 处 createTestObject 调用）
- `test/routes/custom-sql.test.ts`：全局 503 测试改为 per-object 503 测试
- `test/routes/generic-crud.test.ts`：删除"数据源未声明"测试
- `test/routes/join.test.ts`：createTestObject 调用自动兼容（helper 默认值）

### 11. .env 清理

- 删除 `DS_*` 声明块和 `CUSTOM_SQL_ENABLED` 行
- 加注释说明项目 DB 配置已移至 object 表

## 关键设计决策

1. **registry key = object.name**：`getDs("sqlite_app")` 调用方（auth.service.ts、users.service.ts）无需改动
2. **sqlite_app 双重身份**：既是内置 config DB，也是 object 表中的一行；`registerAll()` 先注册内置，`bulkRegisterObjectDsFromDb()` 跳过已注册的
3. **sqlite_app 禁止删除/改连接**：保护 auth/users 服务不断连
4. **CORS 实时读**：每次请求从 object 行读 `cors_origins/cors_methods`，PUT 更新后立即生效，无需重建 map
5. **懒注册**：`resolveObjectAccess` 发现 registry 没有该 object 的 DS 时自动注册（兜底 `bulkRegister` 遗漏的场景）

## 验证

1. `pnpm exec tsc --noEmit` — 0 TS 错误
2. `pnpm test` — 全部通过（原有 138 tests + 修改后的测试）
3. 手动验证：
   - 创建 sqlite 类型 object → CRUD 正常
   - 创建 mysql 类型 object → 连接正常（若有 MySQL）
   - 更新 object 的 cors_origins → 下一个请求 CORS 头变化
   - object.custom_sql_enabled=0 → POST /api/custom/:name 返回 503
   - 删除 sqlite_app → 400 拒绝
