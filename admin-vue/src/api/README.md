# FooseDB SDK（`foose_db.ts`）

> 业务前端通用客户端 —— 独立、零耦合、可抽成 npm 包

## 设计目标

1. **不依赖 admin-vue 内部模块**（不 import `fastify.ts` / `http/index.ts` / `auth.ts`），自己管 axios、登录、token 存储、refresh 轮换、错误解析
2. **强制初始化登录**：`createFooseClient` 必须提供 `username` + `password`，每次初始化从干净状态开始（清自己的 localStorage 缓存），强制 `POST /api/auth/login`
3. **三种 API 层级**：`createFooseClient` 工厂 → `FooseClient.foose*` 方法 → Vue 3 `useFoose` 组合式
4. **零 `any`**：全部 TypeScript 类型安全，只在拦截器框架层做了必要的 `as unknown as` cast

## 依赖

- **axios**（必须，自己管 HTTP）
- **Vue 3**（`ref` 仅组合式 API 部分用；低级 `foose.foose*` 函数不依赖 Vue）

---

## 快速上手

```typescript
import { createFooseClient, useFoose } from "@/api/foose_db";

// —— 初始化（必须用户名密码，每次强制重新登录）——
const foose = await createFooseClient({
  baseURL: "http://api.example.com",
  username: "bob",
  password: "123456"
});
// 自动 POST /api/auth/login → 缓存 token 到 localStorage["foose::auth"]
// access_token 过期后自动 refresh（并发安全）
```

---

## 类型速查

### `CreateFooseOptions`（初始化选项）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `baseURL` | `string` | ❌ | 后端地址，不要带末尾 `/api`；默认 `""` 即相对路径 |
| `username` | `string` | ✅ | 登录用户名 |
| `password` | `string` | ✅ | 登录密码 |
| `clientId` | `string` | ❌ | 自定义 X-Client-Id 指纹；不传则自动生成 UUID v4 并持久化到 localStorage |
| `storageKey` | `string` | ❌ | token 存储的 localStorage key；默认 `"foose::auth"`（唯一命名空间，不与 admin-vue 冲突） |
| `fingerprintKey` | `string` | ❌ | fingerprint 存储的 localStorage key；默认 `"foose::fp"` |
| `timeout` | `number` | ❌ | 请求超时 ms；默认 `15000` |

### `FoosePage<T>`（分页返回）

```typescript
interface FoosePage<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}
```

> 注意：**不再有**扁平 `total` / `page` / `pageSize` 字段，全部在 `meta` 里。

### `FooseListParams`（列表查询参数）

| 字段 | 类型 | 说明 |
|---|---|---|
| `page` | `number` | 页码，默认 `1` |
| `pageSize` | `number` | 每页条数，默认 `20` |
| `nopage` | `boolean` | 跳过分页，返回全部 |
| `orderBy` | `string` | 排序字段 |
| `order` | `"asc" \| "desc"` | 升降序 |
| `fields` | `string` | 返回字段（逗号分隔） |
| `join` | `string` | 关联表 |
| 其余 `status` / `id__gte` / `name__like` ... | `unknown` | 作为 filter 透传给后端 |

### `FooseRow<T>` / `FoosePatch<T>`

```typescript
type FooseRow<T = Record<string, unknown>> = T & { id: number | string };
type FoosePatch<T> = Partial<Omit<T, "id">>;
```

### `FooseAuthResponse`（登录/刷新返回）

```typescript
interface FooseAuthResponse {
  expires: number;
  refresh_expires: number;
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  user: {
    id: number;
    username: string;
    nickname: string | null;
    object_id: number;
    extended: string | null;
    avatar: string | null;
    permissions: string | null;
    roles: string | null;
    email: string | null;
    phone: string | null;
  };
}
```

---

## FooseClient 方法（低级函数 / 非 Vue 上下文可用）

所有方法带 `foose` 前缀以避免与变量名冲突。

### CRUD

| 方法 | 返回 | 说明 |
|---|---|---|
| `fooseList<T>(object, table, params?)` | `Promise<FoosePage<T>>` | 分页列表 |
| `fooseGet<T>(object, table, id, params?)` | `Promise<T>` | 单行详情 |
| `fooseCreate<T>(object, table, data)` | `Promise<T>` | 新建一行 |
| `fooseUpdate<T>(object, table, id, data)` | `Promise<T>` | 更新一行 |
| `fooseRemove(object, table, id)` | `Promise<{ changes: number }>` | 删除一行 |

```typescript
// 示例：非 Vue 上下文（router guard / Pinia store / 纯 JS util）
const page = await foose.fooseList("sqlite_demo", "product", { page: 1, pageSize: 20 });
console.log(page.data);        // Product[]
console.log(page.meta.total);  // number

const row = await foose.fooseGet("sqlite_demo", "product", 42);
await foose.fooseCreate("sqlite_demo", "product", { name: "新商品", price: 99 });
await foose.fooseUpdate("sqlite_demo", "product", 42, { price: 88 });
await foose.fooseRemove("sqlite_demo", "product", 42);
```

### 认证

| 方法 | 返回 | 说明 |
|---|---|---|
| `fooseLogin(username, password)` | `Promise<FooseAuthResponse>` | 登录（失败会 throw） |
| `fooseSafeLogin(username, password)` | `Promise<{ ok: true; data: FooseAuthResponse } \| { ok: false; error: string }>` | 安全登录，失败返回 `{ ok: false, error }`，不 throw |
| `fooseLogout()` | `Promise<void>` | 登出 |
| `fooseIsAuthenticated()` | `boolean` | 是否已认证（同步，读内存 token） |
| `fooseGetCurrentUser()` | `FooseAuthResponse["user"] \| null` | 当前用户信息 |

```typescript
// 安全登录示例
const result = await foose.fooseSafeLogin("alice", "wrong");
if (!result.ok) {
  console.error(result.error); // "登录失败 (HTTP 401)：用户名或密码错误"
} else {
  console.log(result.data.user.username);
}
```

### 状态

| 属性 | 类型 | 说明 |
|---|---|---|
| `foose.loading` | `boolean` | 当前请求是否在进行中 |
| `foose.error` | `string \| null` | 最近一次请求的错误信息 |
| `foose.user` | `FooseAuthResponse["user"] \| null` | 当前用户（只读） |

---

## Vue 3 组合式 API（`useFoose`）

> 自动维护 `data[]` / `meta` / `loading` / `error`，fooseCreate/Update/Remove 时自动同步列表（unshift/splice/filter）。

```typescript
// 组件内使用
import { useFoose } from "@/api/foose_db";

interface Product { id: number; name: string; price: number; stock: number }

const {
  fooseList, fooseGet, fooseCreate, fooseUpdate, fooseRemove,
  data, meta, loading, error, total, current
} = useFoose<Product>(foose, "sqlite_demo", "product");

// 列表加载
await fooseList({ page: 1, pageSize: 20 });
// data.value   → Product[]
// meta.value   → { total, page, pageSize, totalPages }
// loading.value → boolean
// error.value  → string | null（错误自动设置，不 throw）

// 新建：data.value 自动 unshift 新行
await fooseCreate({ name: "新商品", price: 99 });

// 更新：data.value 自动 splice
await fooseUpdate(42, { price: 88 });

// 删除：data.value 自动 filter 移除
await fooseRemove(42);
```

### 返回值

| 成员 | 类型 | 说明 |
|---|---|---|
| `data` | `Ref<T[]>` | 列表数据 |
| `meta` | `Ref<FoosePage<T>["meta"]>` | 分页信息 |
| `loading` | `Ref<boolean>` | 加载状态 |
| `error` | `Ref<string \| null>` | 错误信息 |
| `total` | `Ref<number>` | 总条数（meta.total 的快捷访问） |
| `current` | `Ref<T \| null>` | 当前操作行 |
| `fooseList(params?)` | `Promise<void>` | 加载列表 |
| `fooseGet(id)` | `Promise<T>` | 加载单行到 `current` |
| `fooseCreate(payload)` | `Promise<T>` | 新建并自动 unshift |
| `fooseUpdate(id, payload)` | `Promise<T>` | 更新并自动 splice |
| `fooseRemove(id)` | `Promise<{ changes: number }>` | 删除并自动 filter |

### 工厂版本：`createUseFooseTable`

```typescript
// 适合跨页面复用同一组合式
const useProduct = createUseFooseTable<Product>(foose, "sqlite_demo", "product");

// 每个组件独立调用
const { data, fooseList } = useProduct();
```

---

## 错误处理策略

1. **初始化登录**：`createFooseClient` 内部有 try-catch，失败时设置 `client.error = "..."` 并打印 `console.error`，不会导致页面崩溃
2. **fooseSafeLogin**：返回 `{ ok, data | error }` 结构，完全不 throw
3. **组合式 API**：所有错误写入 `error.value`，**不会 throw**（避免页面 500）
4. **低级函数**：错误会 throw，调用方需要自行 try-catch（适合 router guard 等 JS 上下文）

---

## localStorage 存储键（唯一命名空间）

| Key | 内容 | 生命周期 |
|---|---|---|
| `foose::auth` | `{ access_token, refresh_token, expires, refresh_expires, token_type, user }` | 持久化，登出时清除 |
| `foose::fp` | UUID v4 指纹（X-Client-Id） | 持久化，跨会话复用 |

> **不会**和 admin-vue 的 `authorized-token` 或其他应用冲突。

---

## 后端配合要求

- 后端需启用 `auth_required=1` 并在 `object_table` 白名单声明表名（否则 403）
- `object.cors_origins` 需包含业务前端域名（或 `*`）才能跨域访问
- 登录接口：`POST /api/auth/login`，请求体 `{ username, password }`，header `X-Client-Id`
- 刷新接口：`POST /api/auth/refresh`，请求体 `{ refresh_token }`，header `X-Client-Id`

---

## 文件位置

```
admin-vue/src/api/foose_db.ts   ← SDK 源码（700+ 行，含完整 JSDoc）
admin-vue/src/api/README.md     ← 本文档
```

未来抽成 npm 包时，只需复制 `foose_db.ts` 到新仓库，对外导出 `createFooseClient`、`useFoose`、`createUseFooseTable`、所有类型定义即可。
