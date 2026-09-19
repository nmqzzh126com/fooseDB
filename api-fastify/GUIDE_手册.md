## .env — 多数据源声明完整示例（3 类）
api-fastify/.env:21-53
已加 34 行规范说明 + 示例块，格式：DS_<NAME>__TYPE / __PATH / __URL。现在取消 3 行注释就能声明任何新库
 ===== 示例 B：MySQL 订单库 =====
 DS_MYSQL_ORDERS__TYPE=mysql
 DS_MYSQL_ORDERS__URL=mysql://user:pass@127.0.0.1:3306/orders

 ===== 示例 C：PostgreSQL 商品库 =====
 DS_PG_PRODUCTS__TYPE=postgres
 DS_PG_PRODUCTS__URL=postgres://user:pass@127.0.0.1:5432/products

##  数据库驱动接入示例（MySQL / PG，取消注释即可跑）
mysql.ts src/datasources/mysql.ts:50-118

mysql2/promise createPool（默认 10 连接）
 ? 占位对齐接口 params[] 顺序
事务：getConnection → beginTransaction → fn → commit → rollback on error
postgres.ts src/datasources/postgres.ts:49-118

pg.Pool + 连接串
内置 convertPlaceholders()：把统一接口的 SQL ? 自动转为 $1 $2 …，Service 层写 SQL 不用改
RETURNING id 兜底拿 lastInsertRowid
##  注册表：按请求动态选数据源示例（将来租户模式启用）
src/datasources/registry.ts:112-147
完整 selectByRequest(req) 实现模板，4 级优先级：
?ds=mysql_orders 手工覆盖 → 调试/A-B
x-ds-name HTTP header → 客户端指定
JWT 里的 tenantId → tenant_<id> 命名 → 多租户隔离
fallback getDefaultDs() 兜底主库
##  业务域 Service 示例（3 份，覆盖 3 种典型场景）
文件场景绑定数据源
orders.example.ts	订单 CRUD + 事务（扣余额 + 落订单原子）	mysql_orders（静态绑定）
aggregate.example.ts	跨库聚合报表（同时查 sqlite_app + mysql_orders + pg_products）	三者并行 Promise.all，safeRun 单库失败不拖垮整张报表
users.service.ts（已在用）	用户 CRUD（之前阶段 2 迁入）	sqlite_app
##  Schema + 路由模板（orders 域示例）
schemas/orders.example.ts：OrderIdParam / CreateOrderBody / ListOrdersQuery 等 4 个 JSON Schema 模板
routes/v1/orders.example.ts：订单 4 条路由模板（GET /api/orders list + 详情 + 201 创建 + PATCH /cancel），当前 default export 是空 noop（不抢路径、不 500），取消下面注释即可激活。上线 3 步 checklist 已写在文件头。
##  旧路径兼容层示例（Deprecated 301 转发）
routes/legacy/deprecated.ts:19-41

完整 /api/users → /api/v2/users 5 方法 301 + console.warn Deprecated 日志模板（方法+原路径+新路径），含上线前 checklist：先保证 /api/v2/users 真可用 → 再替换 placeholder → 观察 WARN 数量 7 天降到 0 即下线。

## 🚀 以后怎么启用任意新域（4 步）
.env 取消 2 行 DS_MYSQL_ORDERS__TYPE/URL 注释 → 改真实连接串
pnpm add mysql2 → 打开 mysql.ts 末尾注释 的 5 个方法（替换桩）
把 services/orders.example.ts → 改名为 orders.service.ts，routes/v1/orders.example.ts → 改名为 orders.ts 并取消路由注释块
pnpm build + 启动 → 声明过的所有 DS 名称出现在启动日志和健康接口的datasources 数组中

## 关联子表（JOIN）—— 所有 GET 查询端点通用
src/utils/join.ts + src/services/generic.service.ts + src/routes/v1/generic.ts

### 功能概述
所有 GET 查询端点（分页列表 / nopage 不分页 / `__one` 按条件查一行 / 按主键查 `:id`）都支持通过 `?join=` 参数关联一张或多张子表，返回嵌套的对象（1:1 one）或对象数组（1:N many）。等价于 Directus 的字段级关联能力。

### 语法（约定优先 + 显式可覆盖）
```
join=<term1>,<term2>,...
```
URL 编码；多关联用逗号分隔。单项格式：

```
<table>[:<type>][:<as>][:<onCol>]
```

| 段 | 说明 | 省略时默认值 |
|---|---|---|
| `table` | 同项目（object）下的另一张表名。必须先通过表白名单 & `allow_select=1`。 | 必填 |
| `type` | `one`（1:1，外键在主表）或 `many`（1:N，外键在子表）。 | 自动推断：主表存在 `singular(table)_id` 列 → `one`；否则 → `many` |
| `as` | 返回 JSON 中的嵌套字段名。不能与主表列名冲突（否则 400）。 | `one` → table 本名；`many` → 自动复数化（`+s` / `+es`） |
| `onCol` | 外键列名。 | `one` → `singular(table)_id`（主表列）；`many` → `singular(mainTable)_id`（子表列） |

> **外键推断约定**（Rails/Django 风格）：表名先单数化再拼 `_id`。如 `users` → `user_id`；`posts` → `post_id`；`categories` → `category_id`。
> **复数化规则**：以 `s/x/ch/sh` 结尾 → `+es`；其余 → `+s`。

### 示例
```
# 1. 最简：约定推断（posts 主表有 user_id → users 是 one；comments 子表有 post_id → many）
GET /api/myblog/posts?join=users,comments

# 2. 显式指定类型 + 别名 + 外键列
GET /api/myblog/posts?join=authors:one:writer:author_id,comments:many:replies:post_id

# 3. 按主键查 + join
GET /api/myblog/posts/42?join=authors,comments

# 4. __one 单行条件查 + join
GET /api/myblog/posts?__one=1&title=Hello&join=authors:one:author,comments:many

# 5. 分页 + join（meta.total 不被 many 膨胀）
GET /api/myblog/posts?page=1&pageSize=10&join=comments
```

### 返回结构
LEFT JOIN 保留主表全部行，子表不匹配时嵌套字段为 `null`（one）或 `[]`（many）。

```jsonc
// GET /api/myblog/posts?join=authors:one:author,comments:many
[
  {
    "id": 1,
    "title": "Hello",
    "author_id": 1,
    "author": {              // one → 对象或 null
      "id": 1,
      "name": "Alice"
    },
    "commentses": [          // many → 数组（comments 复数化为 commentses）
      { "id": 10, "post_id": 1, "body": "Nice!" },
      { "id": 11, "post_id": 1, "body": "Cool" }
    ]
  },
  {
    "id": 2,
    "title": "World",
    "author_id": 99,
    "author": null,          // LEFT JOIN 未匹配到 author
    "commentses": []         // 无评论 → 显式空数组
  }
]
```

### 安全护栏
关联的每张子表都**独立走一次** `resolveObjectAccess(object, subTable, 'select', authCtx)`，继承全部安全架构：

- **认证**：object.auth_required=1 → 需有效 Bearer token + 客户端指纹匹配。
- **用户绑定**：绑定用户（object_id ≥ 1）不能 join 其他 object 的子表。
- **配置库自保护**：`object / object_table / users` 等 guarded 表禁止通过 join 访问（403）。
- **表白名单**：主 object 已启用表白名单（至少 1 条 object_table 规则）但子表未在白名单 → 403。
- **表级限制**：子表 `blocked=1` → 403；`allow_select=0` → 403。

### SQL 实现机制
- **LEFT JOIN** + 前缀化列避免名冲突：主表别名 `__m`，第 i 个子表别名 `__j_<i>`。
- SELECT 列前缀：主列 `__m$col`，子列 `__j0$col` / `__j1$col`…。
- **结果归并**（`nestJoinedResults`）：扁平 JOIN 行按主表主键分桶 → 子列拆子对象 → one 覆盖写入 / many 按子 PK 去重 push 到数组。
- **分页 meta.total**：使用 `COUNT(DISTINCT __m.<主PK>)`，避免 1:N 关联导致行数膨胀使 total 翻倍。
- **WHERE / ORDER BY 去歧义**：JOIN 场景下自动把主表列重写为 `__m."col"` 前缀，防止同名列（如 `id`、`user_id`）歧义。
- **`getOne` / `getById`**：JOIN 时去掉 `LIMIT 1`，取全量扁平行后归并，确保 many 子对象数组完整。

### 聚合与 JOIN 互斥
当查询包含 `aggregate[*]` 或 `groupBy=…` 时，JOIN 自动**忽略**（joins 强制置空），返回结构不嵌套，避免聚合语义被 1:N 膨胀破坏。

### 错误语义
| 场景 | HTTP | 错误信息特征 |
|---|---|---|
| 非法表名 / 非法 type / 别名与主表列冲突 / 别名重复 | 400 | `join: invalid ...` / `conflicts with a column` / `duplicate alias` |
| one 时主表 FK 列不存在 | 400 | `expected local FK column "..." on "...", column not found` |
| many 时子表外键列不存在 | 400 | `expected foreign column "..." on "...", column not found` |
| 子表未在表白名单 / blocked=1 / allow_select=0 | 403 | `白名单` / `object_table` / `禁止 select` / `allow_select` |
| 子表是 guarded 配置库表 | 403 | `配置库表 "..." 不允许通过通用接口访问` |

### 涉及文件
| 文件 | 职责 |
|---|---|
| [join.ts](file:///H:/pure-admin-fastify/api-fastify/src/utils/join.ts) | `JoinDesc` 接口、`parseJoinQuery` 语法解析、`validateJoins` 外键校验、`buildJoinSelect` SQL 片段生成、`nestJoinedResults` 结果归并 |
| [generic.service.ts](file:///H:/pure-admin-fastify/api-fastify/src/services/generic.service.ts) | `list` / `getById` / `getOne` 接入 joins + `expandMainSelectList` + `rewriteFilterClauseColumnsToAlias` |
| [generic.ts](file:///H:/pure-admin-fastify/api-fastify/src/routes/v1/generic.ts) | 路由层 `resolveAndValidateJoins`：parse → 逐表过权限+表白名单 → discoverSchema → validateJoins |
| [join.test.ts](file:///H:/pure-admin-fastify/api-fastify/test/routes/join.test.ts) | 9 条专项测试：nopage / page / __one / byId / 白名单 403 / allow_select=0 403 / 外键不存在 400 / 别名冲突 400 / 聚合忽略 JOIN |

## Token 刷新流程 —— accessToken 过期后客户端手动刷新
src/services/auth.service.ts + src/routes/v1/auth.ts

### Token 生命周期

| Token | 有效期 | 用途 | 定义位置 |
|---|---|---|---|
| accessToken | 2 小时 | 访问受保护接口的 Bearer 凭证，每次请求携带 | [auth.service.ts:33-34](file:///H:/pure-admin-fastify/api-fastify/src/services/auth.service.ts#L33) |
| refreshToken | 7 天 | accessToken 过期后用它换取新的 token 对，不直接访问业务接口 | [auth.service.ts:35-36](file:///H:/pure-admin-fastify/api-fastify/src/services/auth.service.ts#L35) |

### 刷新流程（手动，无自动刷新）

当前架构**没有**服务端自动刷新机制，客户端需主动检测 401 并调用刷新接口：

```
1. 客户端携带 accessToken 请求业务接口
2. accessToken 过期 → 服务端返回 401
3. 客户端调用 POST /api/auth/refresh（body: { refresh_token }）
4. 服务端校验 refreshToken 合法性 + 客户端指纹严格匹配
   ├─ 合法 → 签发新的 accessToken + 新的 refreshToken（轮转），旧的 refreshToken 立即失效
   └─ 不合法 → 401，客户端跳转登录
5. 客户端用新 accessToken 重放原请求
```

### 刷新接口

```
POST /api/auth/refresh
Content-Type: application/json

{ "refresh_token": "<JWT refresh token>" }
```

成功响应（200）：
```json
{
  "access_token": "<新 JWT>",
  "refresh_token": "<新 JWT>",
  "token_type": "Bearer",
  "expires_in": 7200
}
```

### 安全机制：RefreshToken 轮转 + 家族撤销

- **轮转（Rotation）**：每次刷新签发全新的 refreshToken，旧的立即标记为 `is_valid=0`。即使旧 token 泄露也无法再次使用。实现位置：[auth.service.ts:448-596](file:///H:/pure-admin-fastify/api-fastify/src/services/auth.service.ts#L448)。
- **重用检测（Reuse Detection）**：如果已失效的 refreshToken 被再次提交（疑似被盗），服务端立即撤销整个 family（家族）的所有 token，强制用户重新登录。每个 refresh_token 关联 `family_id` + `generation`，同 family 任何异常都会连坐。
- **指纹绑定**：刷新时严格比对客户端指纹（SHA256），与登录时的指纹不一致则撤销整个 family。指纹来自请求头 `X-Client-Fingerprint` 或自动计算。
- **token_version 撤销**：用户修改密码 / 管理员强制下线时 bump `users.tv`，所有旧 accessToken 立即失效（进程内 10s TTL 缓存）。位置：[auth.service.ts:42-56](file:///H:/pure-admin-fastify/api-fastify/src/services/auth.service.ts#L42)。

### 客户端推荐实现

```js
let accessToken = localStorage.getItem('access_token');
let refreshToken = localStorage.getItem('refresh_token');

// 请求拦截器：401 时自动用 refreshToken 换新 token，然后重放原请求
async function apiRequest(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['Authorization'] = `Bearer ${accessToken}`;

  let res = await fetch(url, options);

  // accessToken 过期 → 尝试刷新
  if (res.status === 401 && refreshToken) {
    const refreshRes = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });

    if (refreshRes.ok) {
      const data = await refreshRes.json();
      accessToken = data.access_token;
      refreshToken = data.refresh_token;
      localStorage.setItem('access_token', accessToken);
      localStorage.setItem('refresh_token', refreshToken);

      // 用新 token 重放原请求
      options.headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(url, options);
    } else {
      // refreshToken 也过期 / 被撤销 → 跳转登录
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      window.location.href = '/login';
    }
  }

  return res;
}
```

### 涉及文件

| 文件 | 职责 |
|---|---|
| [auth.service.ts](file:///H:/pure-admin-fastify/api-fastify/src/services/auth.service.ts) | Token TTL 定义、`verifyToken` 校验、`login` 签发、`refresh` 轮转+家族撤销、token_version 缓存 |
| [auth.ts](file:///H:/pure-admin-fastify/api-fastify/src/routes/v1/auth.ts) | `POST /api/auth/refresh` 端点、`GET /api/auth/me` 受保护接口 |
| [auth-context.ts](file:///H:/pure-admin-fastify/api-fastify/src/plugins/auth-context.ts) | 请求级 authContext 插件：解析 Bearer token + 计算客户端指纹，供路由层使用 |