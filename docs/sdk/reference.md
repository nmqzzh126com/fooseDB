---
sidebar_position: 1
title: "SDK 参考"
slug: "/sdk/reference"
description: "@fooseDB/sdk TypeScript SDK 完整方法签名 — FooseClient / createUseFoose composable / createFooseApi 纯函数 / FooseTools 零依赖工具"
---

# SDK 参考

`@fooseDB/sdk` 是一个 **零运行时依赖**（仅 devDependencies）的 TypeScript SDK，提供：

| 模块             | 类型                | 适用场景                                         |
| ---------------- | ------------------- | ------------------------------------------------ |
| `FooseClient`    | 类实例              | 手动创建，需要精细控制                           |
| `createUseFoose` | Vue composable 工厂 | **推荐**，带响应式状态（loading/error/dataList） |
| `createFooseApi` | 纯函数 API 工厂     | 非 Vue 环境（Node.js 脚本、React）               |
| `FooseTools`     | 静态工具类          | 零依赖，可独立使用                               |

---

## 快速开始（推荐方式）

### Step 1 — 配置 Vite alias（admin-vue 开发态）

```ts
// vite.config.ts 或 build/utils.ts
resolve: {
  alias: {
    "@fooseDB/sdk": path.resolve(__dirname, "../api-fastify/sdk/src/foose_db.ts")
  }
}
```

或者用 pnpm file: 依赖：

```json
// package.json
{
  "dependencies": {
    "@fooseDB/sdk": "file:../api-fastify/sdk"
  }
}
```

### Step 2 — 创建业务 API 层

```ts
// src/api/demo/foose_base.ts
import type { FooseRow, FooseTableConfig } from "@fooseDB/sdk";
import { createFooseClient, defineFooseTable } from "@fooseDB/sdk";

export const DEFAULT_OBJECT_NAME = "sqlite_demo";

/** 工厂：统一创建 FooseClient + composable */
export function importFooseClient() {
  return createFooseClient({
    baseURL: "http://localhost:8858",
    timeoutMs: 30000,
  });
}

/** 业务表 composable 工厂 */
export function defineFooseTable<T extends FooseRow>(
  options: Omit<FooseTableConfig, "object">,
) {
  const config: FooseTableConfig = {
    object: DEFAULT_OBJECT_NAME,
    defaultPageSize: 10,
    ...options,
  };
  return {
    composable: createUseFoose<T>(config, importFooseClient),
    CONFIG: config,
  };
}
```

### Step 3 — 每张表一个文件

```ts
// src/api/demo/product_api.ts
import type { FooseRow } from "@fooseDB/sdk";
import { defineFooseTable } from "./foose_base";

export interface ProductRow extends FooseRow {
  id: number;
  product_type_id: number;
  product_name: string;
  product_count: number;
  product_desc?: string;
  create_time?: number;
  update_time?: number;
}

export const { composable: useProduct, CONFIG } = defineFooseTable<ProductRow>({
  table: "foose_product",
  autoCreateTimeStampField: "create_time",
  autoUpdateTimeStampField: "update_time",
});
```

### Step 4 — Vue 组件中使用

```vue
<script setup lang="ts">
import { useProduct } from "@/api/demo/product_api";

const {
  dataList, // Ref<ProductRow[]>   列表数据（自动同步）
  loading, // Ref<boolean>        是否请求中
  error, // Ref<string | null>  最近一次错误
  page, // Ref<number>         当前页
  pageSize, // Ref<number>         每页条数
  total, // Ref<number>         总条数
  list, // (params?) => Promise  查询列表
  get, // (id) => Promise      按 ID 查
  create, // (payload) => Promise  创建
  update, // (id, payload) => Promise 更新
  remove, // (id) => Promise      删除
} = useProduct();

// 调用
await list({ page: 1, filter: { product_type_id: 2 } });
</script>

<template>
  <el-table :data="dataList" v-loading="loading">
    <el-table-column prop="product_name" label="商品名" />
    <el-table-column prop="product_count" label="数量" />
  </el-table>
  <el-text v-if="error" type="danger">{{ error }}</el-text>
</template>
```

---

## FooseClient 类方法

手动创建（适合非 Vue 环境或需要精细控制）：

```ts
import { createFooseClient } from "@fooseDB/sdk";

const client = createFooseClient({
  baseURL: "http://localhost:8858",
  timeoutMs: 30000,
});

// 调用
const data = await client.fooseList<ProductRow>(
  "sqlite_demo",
  "foose_product",
  { page: 1 },
);
```

### 完整方法签名

```ts
interface FooseClient {
  // ═══ 通用 CRUD ═══
  fooseList<T>(
    object: string,
    table: string,
    params?: FooseListParams,
  ): Promise<{ data: T[]; meta: FoosePageMeta }>;

  fooseGet<T>(
    object: string,
    table: string,
    id: number | string,
    fields?: string,
    joins?: string,
  ): Promise<T>;

  fooseGetBy<T>(
    object: string,
    table: string,
    params: FooseListParams,
  ): Promise<T | null>;

  fooseCreate<T>(
    object: string,
    table: string,
    data: FoosePatch<T>,
  ): Promise<T>;

  fooseCreates<T>(
    object: string,
    table: string,
    rows: FoosePatch<T>[],
    showSql?: boolean,
  ): Promise<{ ok: boolean; created: number; rows: T[] }>;

  fooseUpdate<T>(
    object: string,
    table: string,
    id: number | string,
    data: Partial<T>,
  ): Promise<T>;

  fooseUpdates<T>(
    object: string,
    table: string,
    rows: Array<Partial<T> & { id: number | string }>,
    showSql?: boolean,
  ): Promise<{ ok: boolean; updated: number; rows: T[] }>;

  fooseRemove(
    object: string,
    table: string,
    id: number | string,
  ): Promise<unknown>;

  fooseRemoves(
    object: string,
    table: string,
    ids: Array<number | string>,
    showSql?: boolean,
  ): Promise<{ ok: boolean; deleted: number }>;

  fooseRemoveByFilter(
    object: string,
    table: string,
    filter: Record<string, unknown>,
    showSql?: boolean,
  ): Promise<{ ok: boolean; deleted: number }>;

  fooseIncDec(
    object: string,
    table: string,
    body: { inc?: Record<string, number>; dec?: Record<string, number> },
    filter?: Record<string, unknown>,
    delay?: number,
  ): Promise<{ ok: boolean; changed: number; rows: unknown[] }>;

  fooseGetValue(
    object: string,
    table: string,
    field: string,
    filter?: Record<string, unknown>,
    limit?: number,
  ): Promise<Array<Record<string, unknown>>>;

  // ═══ 认证 ═══
  fooseLogin(username: string, password: string): Promise<FooseAuthResponse>;
  fooseSafeLogin(
    username: string,
    password: string,
  ): Promise<
    { ok: true; data: FooseAuthResponse } | { ok: false; error: string }
  >;
  fooseLogout(): Promise<void>;
  fooseIsAuthenticated(): boolean;
  fooseGetCurrentUser(): FooseAuthResponse["user"] | null;
  fooseGetAuthInfo(): StoredAuth | null;

  // ═══ 文件操作 ═══
  fooseUpload(
    object: string,
    foldername: string,
    files: File[] | Blob[],
    filenames?: string[],
  ): Promise<{
    ok: boolean;
    count: number;
    files: Array<{
      id: number;
      original_name: string;
      stored_name: string;
      file_path: string;
      file_size: number;
      mime_type: string;
      file_ext: string;
    }>;
  }>;

  fooseDownload(
    object: string,
    fileId: string | number,
  ): Promise<{ blob: Blob; filename: string; contentType: string }>;

  fooseFileList(
    object: string,
    foldername: string,
    page?: number,
  ): Promise<{
    data: unknown[];
    meta: { total: number; page: number; pageSize: number; totalPages: number };
  }>;

  fooseFileDelete(
    object: string,
    foldername: string,
    fileIds: string,
  ): Promise<{
    ok: boolean;
    count: number;
    results: Array<{
      id: number;
      ok: boolean;
      original_name?: string;
      error?: string;
    }>;
  }>;

  fooseFileInfo(
    object: string,
    fileId: string | number,
  ): Promise<{
    id: number;
    original_name: string;
    stored_name: string;
    file_path: string;
    file_size: number;
    mime_type: string;
    file_ext: string;
    foldername: string;
    uploaded_by: string | null;
    uploaded_ip: string;
    created_at: number;
  }>;

  // ═══ 调试 ═══
  fooseGetLastRequest(): FooseLastRequest | null;
}
```

---

## Composable 工厂

### createUseFoose&#60;T&#62;

返回一个 **函数**，调用后得到带响应式状态的 composable 对象：

```ts
const { composable: useProduct } = defineFooseTable<ProductRow>({
  table: "foose_product",
});
const api = useProduct(); // 每次调用返回独立的响应式实例
```

### 返回值结构

| 字段                                | 类型                            | 说明                                                          |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| `loading`                           | `Ref<boolean>`                  | 当前是否请求中                                                |
| `error`                             | `Ref<string \| null>`           | 最近一次请求的错误（中文）                                    |
| `dataList`                          | `Ref<T[]>`                      | 列表数据，被 list/create/update/remove 自动同步               |
| `page`                              | `Ref<number>`                   | 当前页                                                        |
| `pageSize`                          | `Ref<number>`                   | 每页条数                                                      |
| `total`                             | `Ref<number>`                   | 总条数                                                        |
| `list(params?)`                     | `async`                         | 分页查询                                                      |
| `get(id, fields?, joins?)`          | `async`                         | 按 ID 查询单行                                                |
| `getOne(params)`                    | `async`                         | 按条件查单行                                                  |
| `create(payload)`                   | `async`                         | 创建单行，**自动注入时间戳**                                  |
| `creates(payloads[], showSql?)`     | `async`                         | 批量创建，**自动注入时间戳**                                  |
| `update(id, payload)`               | `async`                         | 更新单行，**自动注入时间戳**（无条件覆盖）                    |
| `updates(rows[], showSql?)`         | `async`                         | 批量更新，**自动注入时间戳**（无条件覆盖）                    |
| `remove(id)`                        | `async`                         | 删除单行，自动从 dataList 过滤 + total--                      |
| `removes(ids[], showSql?)`          | `async`                         | 批量删除                                                      |
| `removesByFilter(filter, showSql?)` | `async`                         | 条件批量删除                                                  |
| `incDec(body, filter?, delay?)`     | `async`                         | 原子自增/自减                                                 |
| `getValue(field, filter?, limit?)`  | `async`                         | 单字段聚合查询                                                |
| `lastRequest`                       | `Ref<FooseLastRequest \| null>` | 最近一次请求的完整信息（URL / payload / response / duration） |

---

## FooseTableConfig 配置

```ts
interface FooseTableConfig {
  /** 项目名（URL 第一段） */
  object: string;
  /** 业务表名 */
  table: string;
  /** 默认分页大小，默认 10 */
  defaultPageSize?: number;
  /** 新建操作自动注入 create_time: Date.now()（可被 payload 显式值覆盖） */
  autoCreateTimeStampField?: string;
  /** 更新操作自动注入 update_time: Date.now()（无条件覆盖，不可被显式值覆盖） */
  autoUpdateTimeStampField?: string;
}
```

### 时间戳注入行为

| 操作                 | create 字段       | update 字段                | 显式值优先级                          |
| -------------------- | ----------------- | -------------------------- | ------------------------------------- |
| `create` / `creates` | 注入 `Date.now()` | 也注入（刚创建时两值相等） | create 字段尊重显式值（导入历史数据） |
| `update` / `updates` | —                 | **无条件覆盖**             | —                                     |

---

## FooseListParams 查询参数

```ts
interface FooseListParams {
  page?: number;
  pageSize?: number;
  sort?: string; // 如 "id:desc" 或 "create_time:asc"
  fields?: string; // 逗号分隔字段白名单
  filter?: Record<string, unknown>; // Directus 风格
  joins?: Array<{
    table: string;
    as?: string;
    type?: "one" | "many";
    on: { local: string; foreign: string };
  }>;
  showSql?: boolean;
}
```

### Directus 风格 filter

```ts
// 简单等于
{
  filter: {
    status: 1;
  }
}

// 嵌套操作符
{
  filter: {
    product_count: {
      _gt: 100;
    }
  }
}
{
  filter: {
    product_name: {
      _contains: "手机";
    }
  }
}
{
  filter: {
    status: {
      _in: [1, 2, 3];
    }
  }
}
```

---

## 错误处理

### SDK 错误拦截器

所有 HTTP 错误会被统一解析成带**中文业务错误**的 Error：

```ts
try {
  await api.update(1, { product_count: 999 });
} catch (err) {
  console.log(err.message);
  // "项目 sqlite_demo 已被禁用"
  // "项目 sqlite_demo 未开启 update 权限"
  // "账号或密码错误"
  // "文件 photo.png 的类型 '.exe' 不在允许列表中"
}
```

### composable 的 error ref

```vue
<el-alert v-if="error" :title="error" type="error" />
```

### 特殊 401 处理

- access token 过期 → SDK 自动 refresh → 重试原请求
- refresh token 也过期 → 清空 auth → 返回 `未授权 (401)`
- 多个并发 401 → 单飞模式，只触发一次 refresh
- `X-Client-Id` 不匹配 → 返回 `未授权 (401)`（同时清空 auth）

### Blob 错误体

`fooseDownload` 的 403 错误体是 Blob（后端返回 JSON 但 responseType=blob）。SDK **已修复**：

```
拦截器 error handler:
  if (config.responseType === "blob" && data instanceof Blob) {
    const text = await blob.text();
    const parsed = JSON.parse(text);
    response.data = parsed;   // 替换成解析好的 JSON
  }
// extractError 之后就能正确读取 message 字段
```

---

## FooseTools 零依赖工具类

```ts
import { FooseTools } from "@fooseDB/sdk";

// 生成带前缀的短 ID
FooseTools.createTableId(); // → "tbl_8f3a2c1d"
FooseTools.createTableId("usr"); // → "usr_b2c3d4e5"

// 生成带 id 前缀的 UUID（去连字符）
FooseTools.createUuid(); // → "id_8f3a2c1de5f64a7b8c9d0e1f2a3b4c5d"
FooseTools.createUuid("doc"); // → "doc_b2c3d4e5f6a74b8c9d0e1f2a3b4c5d6e"

// 异步延迟
await FooseTools.sleep(1000);

// 安全 JSON 解析（try/catch 兜底）
FooseTools.safeParse("{invalid"); // → null
FooseTools.safeParse('{"a":1}'); // → { a: 1 }

// 深安全 JSON 序列化
FooseTools.safeStringify(obj);

// 数组去重
FooseTools.uniqueArray([1, 2, 2, 3]); // → [1, 2, 3]

// pick / omit 对象字段
FooseTools.pick({ a: 1, b: 2, c: 3 }, ["a", "c"]); // → { a: 1, c: 3 }
FooseTools.omit({ a: 1, b: 2, c: 3 }, ["b"]); // → { a: 1, c: 3 }
```

### 零依赖设计

FooseTools 是 SDK 里的独立部分，只依赖浏览器内建对象。如果你只需要工具函数，可以**直接从源码拷贝**，不需要整个 SDK：

```ts
// 源码：sdk/src/foose_db.ts 底部 FooseTools 类定义
```

---

## SDK 版本常量

```ts
import { FOSE_SDK_VERSION } from "@fooseDB/sdk";
console.log(FOSE_SDK_VERSION); // 7（每次发布递增）
```

index.vue 可以做版本健康检查：

```vue
<script setup>
import { FOSE_SDK_VERSION } from "@fooseDB/sdk";
// 如果浏览器缓存了旧 chunk，版本号和源码不一致
</script>
```

---

## 最佳实践

### ✅ 推荐

```ts
// 每张表一个文件，通过 defineFooseTable 工厂统一
export const { composable: useProduct, CONFIG } = defineFooseTable<ProductRow>({
  table: "foose_product",
  autoUpdateTimeStampField: "update_time",
});
```

### ❌ 不推荐

```ts
// ❌ 在组件里手动创建 FooseClient（每次组件重建都会新实例）
// ❌ 手动处理 loading / error / refresh（SDK 已经内置）
// ❌ 绕过 SDK 直接 axios 调接口（丢失 fingerprint + 自动 refresh + 中文错误）
```

### 测试阶段开发技巧

admin-vue 通过 Vite alias 直接指向 SDK `.ts` 源码：

```ts
// build/utils.ts
alias: {
  "@fooseDB/sdk": pathResolve("../../api-fastify/sdk/src/foose_db.ts")
}
```

**改 SDK 源码 → 保存 → admin-vue HMR 自动刷新**，不需要 build / sync。

生产构建时切回 `file:../api-fastify/sdk` 依赖，用 tsup 编译后的 dist 文件。
