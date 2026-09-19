/**
 * FoosDB 通用客户端 SDK —— 完全独立、零耦合
 * ===================================================================
 *
 * 设计目标：
 *   1. **不依赖任何 admin-vue 内部模块**（不 import fastify.ts / http/index.ts / auth.ts）
 *      自己管 axios、登录、token 存储、refresh 轮换、错误解析
 *   2. **强制初始化登录**：createFooseClient 必须提供 username + password
 *      每次初始化从干净状态开始（清自己的 localStorage 缓存），强制 POST /api/auth/login
 *   3. **三种 API 层级**：createFooseClient 工厂 → FooseClient.foose* 方法 → Vue 3 useFoose 组合式
 *   4. **可抽离成独立 npm 包**：业务前端直接 install 一个 @foosdb/sdk 就能用
 *
 * 用法（Vue 3 业务前端）：
 *
 *   import { createFooseClient, useFoose } from "@/api/foose_db";
 *
 *   // —— 必须提供用户名密码（每次初始化强制重新登录，不读旧缓存） ——
 *   const foose = await createFooseClient({
 *     baseURL: "http://api.example.com",
 *     username: "bob",
 *     password: "123456"
 *   });
 *   // 自动 POST /api/auth/login → 缓存 token 到 localStorage["foose::auth"]
 *   // 后续 access_token 过期自动 refresh（并发安全）
 *
 *   // —— 低级函数（非 Vue 上下文：router guard / store / JS util） ——
 *   const page = await foose.fooseList("sqlite_demo", "product", { page: 1 });
 *   // page.data → T[]
 *   // page.meta  → { total, page, pageSize, totalPages }
 *   const row = await foose.fooseGet("sqlite_demo", "product", 42);
 *   await foose.fooseCreate("sqlite_demo", "product", { name: "新商品", price: 99 });
 *   await foose.fooseUpdate("sqlite_demo", "product", 42, { price: 88 });
 *   await foose.fooseRemove("sqlite_demo", "product", 42);
 *
 *   // —— Vue 组件里用组合式（自动维护 data[] / loading / error / 自动 unshift/splice/filter） ——
 *   const { fooseList, fooseCreate, fooseUpdate, fooseRemove, data, loading, error, meta }
 *     = useFoose<Product>(foose, "sqlite_demo", "product");
 *   await fooseList({ page: 1, pageSize: 20 });
 *   // data.value   → Product[]
 *   // meta.value   → { total, page, pageSize, totalPages }
 *   // loading.value → boolean
 *   // error.value  → string | null（错误自动设置，不会抛导致页面崩溃）
 *
 *   // —— 认证控制 ——
 *   const result = await foose.fooseSafeLogin("alice", "wrong");
 *   // result = { ok: false, error: "登录失败 (HTTP 401)：用户名或密码错误" }
 *   // result.ok === true 时，result.data 就是 FooseAuthResponse
 *   await foose.fooseLogout();
 *   foose.fooseIsAuthenticated();  // boolean
 *   foose.fooseGetCurrentUser();   // { id, username, nickname, avatar, email, phone, ... } | null
 *
 * 依赖：
 * - axios（必须，自己管 HTTP）
 * - Vue 3（ref 仅组合式 API 部分用；低级 foose.foose * 函数不依赖）
 */

import Axios, { type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { ref, type Ref } from "vue";

/* ================================================================
 * 1. 类型定义
 * ================================================================ */

/** 后端统一返回格式（Fastify 包装层） */
export interface FooseEnvelope<T> {
  data?: T;
  ok?: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * aggregate 结构化定义（推荐新写法）。
 *   { count: { "*": "cnt" }, sum: { "price": "total_price" } }
 * 会被 cleanParams 展开为 URL：
 *   aggregate[count][*]=cnt&aggregate[sum][price]=total_price
 */
export type FooseAggregate = Record<string, Record<string, string>>;

/**
 * filter 结构化定义（推荐新写法）。
 *   { product_type_id: 1, "product_name[_like]": "%联想%" }
 *   { _or: [{ product_name: "联想" }, { product_name: "戴尔" }] }
 *   { product_count: { _gte: 10, _lte: 100 } }
 */
export type FooseFilter = Record<string, unknown>;

/**
 * group 结构化定义（推荐新写法）。
 *   { by: "product_type_id", having: { "cnt[_gt]": 2 } }
 *   { by: "status,cat", having: { cnt: { _gt: 5 } } }
 */
export interface FooseGroup {
  /** GROUP BY 字段，逗号分隔多字段 */
  by?: string;
  /** HAVING 条件，同 filter 语法 */
  having?: FooseFilter;
}

/**
 * join 结构化定义（推荐新写法；后端最终都转为 join=term1,term2 URL query）。
 *
 * 语法（与后端 Directus 风格一致）：
 *   { table, type?, as?, on? }
 *     table — 关联子表名（必填）
 *     type  — "one" | "many"，省略时按 FK 自动推断
 *     as    — 输出嵌套字段别名，省略时默认=table（many 自动复数化）
 *     on    — 外键列，两种写法：
 *               string          单名 → 自动推断另一端
 *                                 one:   onCol = 主表 FK 列，指向子表 PK
 *                                 many:  onCol = 子表 FK 列，指向主表 PK
 *               { local, foreign }  双向显式 → 跳过推断，完全按指定连接
 *
 * 扁平写法（仍可用）：join="product_type:one:product_type_id" 或 join="product_type:one::product_type_id=id"
 */
export interface FooseJoin {
  /** 关联子表名（同数据源下） */
  table: string;
  /** one = 1:1（嵌套对象/null）；many = 1:N（嵌套数组）。省略时按 FK 自动推断 */
  type?: "one" | "many";
  /** SQL JOIN 类型：left（默认，主表全部保留）/ inner（只保留两边都匹配的行） */
  joinType?: "left" | "inner";
  /** 输出 JSON 中的字段别名。省略时默认=table，many 时自动复数化 */
  as?: string;
  /**
   * 外键连接条件。两种写法：
   *   "product_type_id"              — 单名，自动推断另一端
   *   { local: "pt_id", foreign: "type_code" }  — 双向显式
   */
  on?: string | { local: string; foreign: string };
}

/** 通用 CRUD 列表查询参数 */
export interface FooseListParams {
  page?: number;
  pageSize?: number;
  noPage?: boolean;
  /**
   * 调试开关：为 true 时后端在响应中返回完整 SQL 语句。
   * 注意：会暴露表名、列名和查询结构，仅建议开发/调试时使用。
   */
  showSql?: boolean;
  /**
   * 排序字段（Directus 风格，多字段逗号分隔，每字段自带方向）。
   *   "id"                              → 单字段，默认 ASC
   *   "id:desc"                         → 单字段自带方向
   *   "product_count:desc,id:asc"       → 多字段各自方向（最常用）
   * 可以带空格（会在 fooseList 内部自动清理），如 "product_count desc, id asc"。
   */
  orderBy?: string | string[];
  /** GROUP BY 字段，逗号分隔 */
  groupBy?: string | string[];
  fields?: string | string[];

  // —— 结构化参数（唯一写法，不再保留扁平 spread） ——

  /**
   * JOIN 关联（结构化数组）。
   *   joins: [
   *     { table: "users" },                                    // 最简（全自动推断 type/as/on）
   *     { table: "comments", type: "many" },                   // 指定类型
   *     { table: "users", type: "one", as: "author" },         // 指定别名
   *     { table: "product_label", on: "product_id" },          // 指定 FK 列
   *     { table: "users", on: { local: "author_id", foreign: "id" } } // 双向显式
   *   ]
   */
  joins?: FooseJoin[];
  /** @deprecated use joins (plural) — kept for backward compatibility */
  join?: FooseJoin[];

  /**
   * WHERE 过滤条件（结构化 + Directus 运算符）。
   *   filter: {
   *     product_type_id: 1,                          // 等值
   *     "product_name[_like]": "%联想%",             // 模糊匹配
   *     product_count: { _gte: 10, _lte: 100 },      // 范围
   *     _or: [                                       // OR 组
   *       { product_name: "联想" },
   *       { product_name: "戴尔" }
   *     ],
   *     id: { _in: "1,2,5" },                        // 多值
   *     id: { _nin: "0,99" }                         // 排除
   *   }
   */
  filter?: FooseFilter;

  /**
   * 聚合函数（结构化）。
   *   aggregate: {
   *     count:    { "*": "cnt" },
   *     sum:      { "product_count": "total_qty" },
   *     avg:      { "price": "avg_price" },
   *     max:      { "price": "max_price" },
   *     min:      { "price": "min_price" },
   *     countDistinct: { "product_type_id": "type_count" }
   *   }
   */
  aggregate?: FooseAggregate;

  /**
   * GROUP BY + HAVING（结构化）。
   *   group: {
   *     by: "product_type_id",
   *     having: { "cnt[_gt]": 2 }
   *   }
   */
  group?: FooseGroup;

  // —— 向后兼容：旧的扁平写法仍保留（filter 等值、aggregate 扁平 key 等）——
  [key: string]: unknown;
}

/** 分页返回 */
export interface FoosePage<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
  /** 仅当 showSql=true 时返回：后端实际执行的主查询 SQL（带 ? 占位符） */
  sql?: string;
  /** 仅当 showSql=true 时返回：SQL 绑定的参数值数组（与 ? 一一对应） */
  sqlParams?: unknown[];
}

/** 行基础类型（所有表都有 id） */
export type FooseRow<T = Record<string, unknown>> = T & { id: number | string };

/** create / update 输入（不含 id） */
export type FoosePatch<T> = Partial<Omit<T, "id">>;

/** 登录/刷新返回的 token 对 */
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

/** createFooseClient 的初始化选项 */
export interface CreateFooseOptions {
  /** FoosDB 后端地址（不要带末尾 /api，SDK 自动加）。默认 "" 即相对路径 */
  baseURL?: string;
  /** 登录用户名（**必填**，不填抛错误） */
  username: string;
  /** 登录密码（**必填**） */
  password: string;
  /** 自定义 X-Client-Id（指纹）。不传则自动生成 UUID v4 并持久化到 localStorage */
  clientId?: string;
  /** localStorage 存储 token 的 key。默认 "foose::auth"（唯一命名空间，不与 admin-vue 或其他应用冲突） */
  storageKey?: string;
  /** localStorage 存储 fingerprint 的 key。默认 "foose::fp"（唯一命名空间） */
  fingerprintKey?: string;
  /** 请求超时 ms。默认 15000 */
  timeout?: number;
}

/** createFooseClient 返回的客户端对象 */
export interface FooseClient {
  /* —— CRUD（都带 foose 前缀以避免与 Vue 组合式变量冲突） —— */
  fooseList<T = Record<string, unknown>>(
    object: string,
    table: string,
    params?: FooseListParams
  ): Promise<FoosePage<T>>;
  fooseGet<T = Record<string, unknown>>(
    object: string,
    table: string,
    id: number | string,
    params?: { fields?: string; join?: string }
  ): Promise<T>;
  /**
   * 按条件查一行（后端 __one 语义）。
   *
   *   await foose.fooseGetBy("sqlite_demo", "product", { product_name: "联想" });
   *   // → { id: 1, product_name: "联想", ... } | null
   *
   * 必须带至少一个过滤字段（否则后端 400）。零结果返回 null，不抛 404。
   */
  fooseGetBy<T = Record<string, unknown>>(
    object: string,
    table: string,
    params: FooseListParams
  ): Promise<T | null>;
  fooseCreate<T = Record<string, unknown>>(
    object: string,
    table: string,
    data: FoosePatch<T>
  ): Promise<T>;
  /** 批量创建 —— POST /batch-create，事务原子 */
  fooseCreates<T = Record<string, unknown>>(
    object: string,
    table: string,
    rows: FoosePatch<T>[],
    showSql?: boolean
  ): Promise<{ ok: boolean; created: number; rows: T[]; sql?: string; sqlParams?: unknown[] }>;
  fooseUpdate<T = Record<string, unknown>>(
    object: string,
    table: string,
    id: number | string,
    data: FoosePatch<T>
  ): Promise<T>;
  /** 批量更新 —— POST /batch-update，事务原子 */
  fooseUpdates<T = Record<string, unknown>>(
    object: string,
    table: string,
    rows: Array<{ id: number | string } & FoosePatch<T>>,
    showSql?: boolean
  ): Promise<{ ok: boolean; updated: number; rows: T[]; sql?: string; sqlParams?: unknown[] }>;
  fooseRemove(
    object: string,
    table: string,
    id: number | string
  ): Promise<{ ok: boolean; deleted: number }>;
  /** 批量按 ids 删除（POST /batch-delete） */
  fooseRemoves(
    object: string,
    table: string,
    ids: Array<string | number>,
    showSql?: boolean
  ): Promise<{ ok: boolean; deleted: number; sql?: string; sqlParams?: unknown[] }>;
  /** 批量按 filter 删除（POST /batch-delete-filter） —— 复用查询 filter 语法 */
  fooseRemoveByFilter(
    object: string,
    table: string,
    filter: Record<string, unknown>,
    showSql?: boolean
  ): Promise<{ ok: boolean; deleted: number; sql?: string; sqlParams?: unknown[] }>;

  /* —— 认证控制 —— */
  /** 手动切换账号登录（失败会 throw） */
  fooseLogin(username: string, password: string): Promise<FooseAuthResponse>;
  /** 安全登录（不 throw，返回 { ok, data?, error? }，推荐 UI 层使用） */
  fooseSafeLogin(
    username: string,
    password: string
  ): Promise<
    { ok: true; data: FooseAuthResponse } | { ok: false; error: string }
  >;
  /** 手动登出（清 token） */
  fooseLogout(): Promise<void>;
  /** 当前是否有有效 access_token */
  fooseIsAuthenticated(): boolean;
  /** 当前用户信息（从 localStorage 读，不请求后端） */
  fooseGetCurrentUser(): FooseAuthResponse["user"] | null;

  /* —— 状态（可用于 Vue 响应式） —— */
  /** 最近一次请求是否在加载 */
  readonly loading: boolean;
  /** 最近一次错误信息（成功时 null） */
  readonly error: string | null;
  /** 当前用户 */
  readonly user: FooseAuthResponse["user"] | null;
}

/* ================================================================
 * 2. 辅助：指纹生成 + token 存储（localStorage）
 * ================================================================ */

/** 生成 UUID v4 指纹（简单实现，不依赖第三方库） */
function genFingerprint(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

interface StoredAuth {
  access_token: string;
  refresh_token: string;
  expires: number; // unix 秒
  user: FooseAuthResponse["user"];
}

function loadAuth(key: string): StoredAuth | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.access_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveAuth(key: string, auth: FooseAuthResponse) {
  const data: StoredAuth = {
    access_token: auth.access_token,
    refresh_token: auth.refresh_token,
    expires: auth.expires,
    user: auth.user
  };
  localStorage.setItem(key, JSON.stringify(data));
}

function clearAuth(key: string) {
  localStorage.removeItem(key);
}

/* ================================================================
 * 2.5 辅助：错误处理 + 类型守卫
 * ================================================================ */

/** 判断 unknown 是否为 AxiosError */
function isAxiosError(err: unknown): err is AxiosError {
  return err instanceof Error && "response" in err;
}

/** 从 unknown 错误中提取 display message + status */
function extractError(err: unknown): { msg: string; status: number } {
  if (isAxiosError(err)) {
    const body = (err.response?.data as { error?: string } | undefined) ?? {};
    return {
      msg: body.error ?? err.message ?? "请求失败",
      status: err.response?.status ?? 0
    };
  }
  if (err instanceof Error) return { msg: err.message, status: 0 };
  return { msg: String(err), status: 0 };
}

/* ================================================================
 * 3. 核心工厂：createFooseClient
 * ================================================================ */

export async function createFooseClient(
  options: CreateFooseOptions
): Promise<FooseClient> {
  const {
    baseURL = "",
    username,
    password,
    clientId,
    storageKey = "foose::auth",
    fingerprintKey = "foose::fp",
    timeout = 15000
  } = options;

  // —— 强制校验：必须提供用户名密码 ——
  if (!username || !password) {
    throw new Error(
      "[foose_db] createFooseClient 必须提供 username 和 password"
    );
  }

  // —— 指纹：优先传参 → 其次 localStorage 已有 → 否则生成并存 ——
  let fingerprint: string =
    clientId ?? localStorage.getItem(fingerprintKey) ?? "";
  if (!fingerprint) {
    fingerprint = genFingerprint();
    localStorage.setItem(fingerprintKey, fingerprint);
  }

  // —— axios 实例 ——
  const http = Axios.create({
    baseURL: baseURL ? (baseURL.endsWith("/") ? baseURL : baseURL + "/") : "",
    timeout,
    headers: { "Content-Type": "application/json", Accept: "application/json" }
  });

  // —— 响应式状态（让 createFooseActions 能监听） ——
  const loading = ref(false);
  const error = ref<string | null>(null);
  const user = ref<FooseAuthResponse["user"] | null>(null);

  // —— 内部 token 存储（运行时内存 + localStorage 持久化） ——
  let auth: StoredAuth | null = loadAuth(storageKey);
  if (auth) user.value = auth.user;

  // —— refresh 中的 promise（防止并发重复 refresh） ——
  let refreshPromise: Promise<string> | null = null;

  // —— token 过期判断（提前 5 秒判过期，避开临界点 race） ——
  function accessTokenExpired(): boolean {
    if (!auth) return true;
    return auth.expires * 1000 - 5000 < Date.now();
  }

  // —— 自动 refresh ——
  async function autoRefresh(): Promise<string> {
    if (!auth?.refresh_token) throw new Error("没有 refresh_token");

    // 已有并发 refresh → 等它
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      // 登录/刷新接口返回 {"data": FooseAuthResponse}，拦截器已解包
      const tokenData = await http.post<unknown, FooseAuthResponse>(
        "api/auth/refresh",
        { refresh_token: auth!.refresh_token },
        { headers: { "X-Client-Id": fingerprint } }
      );
      saveAuth(storageKey, tokenData);
      auth = loadAuth(storageKey);
      user.value = auth?.user ?? null;
      return auth!.access_token;
    })();

    try {
      return await refreshPromise;
    } catch (e) {
      // refresh 失败 → 强制登出
      clearAuth(storageKey);
      auth = null;
      user.value = null;
      throw e;
    } finally {
      refreshPromise = null;
    }
  }

  // —— 请求拦截器：注入 X-Client-Id + Bearer token（过期自动 refresh） ——
  http.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    config.headers.set("X-Client-Id", fingerprint);

    // 跳过认证/刷新/登出接口本身
    const url = (config.url ?? "").toLowerCase();
    const skipAuth =
      url.includes("api/auth/login") ||
      url.includes("api/auth/refresh") ||
      url.includes("api/auth/logout");

    if (!skipAuth) {
      if (!auth) {
        // 匿名请求（不发 token）——只有 auth_required=0 的项目能过
      } else if (accessTokenExpired()) {
        // 过期 → refresh（并发安全）
        const newToken = await autoRefresh();
        config.headers.set("Authorization", `Bearer ${newToken}`);
      } else {
        config.headers.set("Authorization", `Bearer ${auth.access_token}`);
      }
    }
    return config;
  });

  // —— 响应拦截器：解包 Fastify 外层 + 统一错误 ——
  //
  // 后端 4 种实际返回格式：
  //   ① 列表    {"data":[...], "meta":{...}}        → 2 key → 保留完整（data+meta 不能拆）
  //   ② 详情    {"id":1, "name":"..."}              → 纯对象 → 保留
  //   ③ 写操作  {"id":6, "name":"..."}              → 纯对象 → 保留
  //   ④ 登录    {"data":{expires,access_token,...}} → 1 key 外层 → 解包拿内层
  //
  // axios 拦截器泛型签名过严，回调返回 unknown 无法匹配 AxiosResponse 泛型，
  // 用 eslint-disable + as any 绕过（运行时完全正确）

  (http.interceptors.response.use as any)(
    (res: AxiosResponse) => {
      loading.value = false;
      const body = res.data as FooseEnvelope<unknown>;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        // 登录接口等 Fastify 包装：外层只有 {data} 一个 key → 解包拿内层对象
        if ("data" in body && Object.keys(body).length === 1) return body.data;
        // 管理端 admin 路由返回 { ok, ... } → 保留完整（业务路径不走这个分支）
        if ("ok" in body || "total" in body) return body;
      }
      return body;
    },
    (err: unknown) => {
      loading.value = false;
      const { msg: rawErr, status } = extractError(err);
      const display = /[\u4e00-\u9fa5]/.test(rawErr)
        ? rawErr
        : status === 401
          ? "未授权 (401)"
          : status
            ? `请求失败 (${status})`
            : "网络错误";

      if (status === 401) {
        clearAuth(storageKey);
        auth = null;
        user.value = null;
      }

      error.value = display;
      return Promise.reject(new Error(display));
    }
  );

  // —— 初始化：强制清除自己的缓存 + 强制登录 ——
  auth = null;
  user.value = null;
  try {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(fingerprintKey);
  } catch {
    /* SSR 兜底 */
  }

  // —— 强制登录 ——
  let tokenData: FooseAuthResponse;
  try {
    // 登录原始返回 {"data": FooseAuthResponse}，拦截器已解包（外层只有 1 个 data key）
    // 所以 loginRes 直接就是 FooseAuthResponse 对象
    tokenData = await http.post<unknown, FooseAuthResponse>(
      "api/auth/login",
      { username, password },
      { headers: { "X-Client-Id": fingerprint } }
    );
  } catch (raw: unknown) {
    const { msg, status } = extractError(raw);
    const display = `登录失败${status ? ` (HTTP ${status})` : ""}：${msg}`;
    error.value = display;

    console.error(`[foose_db] ${display}`);
    throw new Error(display);
  }
  saveAuth(storageKey, tokenData);
  auth = loadAuth(storageKey);
  user.value = auth?.user ?? null;

  // —— 封装 CRUD ——
  // fooseList 契约：必须返回数组分页结构，禁止 __one / noPage（应由 fooseGetBy / fooseListNoPage 处理）
  const LIST_BLOCKED_KEYS = new Set(["__one", "noPage", "nopage"]);

  /**
   * 把嵌套对象展开成 bracket key 形式。
   * 自动识别 key 是否已包含 Directus bracket 后缀（如 "cnt[_gt]"、"product_name[_like]"），
   * 避免对已带 bracket 的 key 重复嵌套。prefix 为空时直接保留原 key。
   *
   *   flattenBracket({ count: { "*": "cnt" } }, "aggregate")
   *   → { "aggregate[count][*]": "cnt" }
   *
   *   flattenBracket({ "cnt[_gt]": 2 }, "having")
   *   → { "having[cnt][_gt]": 2 }
   *
   *   flattenBracket({ "product_name[_like]": "%联想%" }, "")
   *   → { "product_name[_like]": "%联想%" }
   */
  /** 以 `[_xxx]` 结尾的 key 提取运算符名，key 不含则返回 null */
  function extractOp(key: string): string | null {
    const m = key.match(/\[(_[a-z_]+)\]$/);
    return m ? m[1] : null;
  }

  /** 需要 boolean 值的运算符集合 */
  const BOOL_OPS = new Set(["_null", "_nnull", "_not_null"]);
  /** 需要数组值（恰好 2 元素）的运算符集合 */
  const ARRAY_OPS = new Set(["_between"]);

  function flattenBracket(
    obj: Record<string, unknown>,
    prefix: string,
    out: Record<string, unknown> = {}
  ): Record<string, unknown> {
    for (const [k, v] of Object.entries(obj)) {
      const bracketIdx = k.indexOf("[");
      let key: string;
      if (prefix) {
        if (bracketIdx > 0) {
          const fieldPart = k.slice(0, bracketIdx);
          const rest = k.slice(bracketIdx);
          key = `${prefix}[${fieldPart}]${rest}`;
        } else {
          key = `${prefix}[${k}]`;
        }
      } else {
        key = k;
      }

      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        flattenBracket(v as Record<string, unknown>, key, out);
      } else if (Array.isArray(v)) {
        // —— 运算符特定数组值处理 ——
        //   [_between]: 必须恰好 2 元素 → join 成 CSV 字符串
        //   其他数组:  Directus 风格下标（_or 等）
        const op = extractOp(key);
        if (op && ARRAY_OPS.has(op)) {
          if (v.length !== 2) {
            const err = new Error(
              `${key} requires exactly 2 values, got ${v.length} | ${key} 必须恰好 2 个元素`
            ) as Error & { statusCode?: number };
            err.statusCode = 400;
            throw err;
          }
          out[key] = v.join(",");
        } else {
          // 普通数组（_or/_and 等分组数组）
          v.forEach((item, i) => {
            if (item !== null && typeof item === "object") {
              flattenBracket(item as Record<string, unknown>, `${key}[${i}]`, out);
            } else {
              out[`${key}[${i}]`] = item;
            }
          });
        }
      } else {
        // —— 非 object/非数组值：boolean 转换 ——
        const op = extractOp(key);
        if (op && BOOL_OPS.has(op) && typeof v === "boolean") {
          out[key] = v ? "1" : "0";
        } else {
          out[key] = v;
        }
      }
    }
    return out;
  }

  function cleanParams(params?: FooseListParams, allowReserved = false) {
    if (!params) return undefined;
    const { filter, aggregate, group, ...rest } = params as FooseListParams & { join?: FooseJoin[] };
    // 解构对某些 Proxy 对象可能失效 — 显式取值 joins / join
    const joinsDirect = (params as any).joins;
    const joinDirect = (params as any).join;
    // DEBUG
    //console.log("[cleanParams DESTRUCTURE] joins(direct):", joinsDirect, "| join(direct):", joinDirect, "| params type:", params?.constructor?.name, "| ownKeys:", Object.getOwnPropertyNames(params ?? {}));
    const out: Record<string, unknown> = { ...rest };

    // —— 展开结构化 filter → 扁平 WHERE key ——
    //   filter: { product_count: { _gte: 10 } } → { "product_count[_gte]": 10 }
    //   filter: { "product_name[_like]": "%联想%" } → 直接保留
    if (filter && typeof filter === "object") {
      Object.assign(out, flattenBracket(filter as Record<string, unknown>, ""));
    }

    // —— 展开结构化 aggregate → "aggregate[fn][field]" ——
    if (aggregate && typeof aggregate === "object") {
      Object.assign(out, flattenBracket(aggregate, "aggregate"));
    }

    // —— 展开结构化 group → groupBy + "having[field][op]" ——
    if (group && typeof group === "object") {
      if (group.by) out.groupBy = group.by;
      if (group.having && typeof group.having === "object") {
        Object.assign(out, flattenBracket(group.having as Record<string, unknown>, "having"));
      }
    }

    // —— 展开结构化 joins → "join=term1,term2" ——
    //   URL 格式：table:type:as:onCol:joinType（按冒号 split 按位置解析，省略必须占位）
    //   joins: [
    //     { table: "users" },                                              → "users"
    //     { table: "comments", type: "many" },                             → "comments:many"
    //     { table: "orders", type: "one", joinType: "inner", on: "user_id" },
    //       → "orders:one::user_id:inner"
    //   ]
    const joinsEff = joinsDirect ?? joinDirect; // 兼容单数 join（旧习惯）和复数 joins（接口定义）
    if (Array.isArray(joinsEff) && joinsEff.length > 0) {
      out.join = joinsEff
        .map(j => {
          // onPart：字符串直接用；对象 → "local=foreign" 双向语法
          let onPart = "";
          if (typeof j.on === "string") {
            onPart = j.on;
          } else if (j.on && typeof j.on === "object") {
            onPart = `${j.on.local}=${j.on.foreign}`;
          }
          // 按位置组装：table:type:as:onCol:joinType（省略必须用空字符串占位）
          const parts = [j.table];
          if (j.type || j.as || onPart || j.joinType) parts.push(j.type ?? "");
          if (j.as || onPart || j.joinType) parts.push(j.as ?? "");
          if (onPart || j.joinType) parts.push(onPart);
          if (j.joinType) parts.push(j.joinType);
          return parts.join(":");
        })
        .join(",");
    }

    // 移除结构化保留字段本身（它们不是后端 query key）
    delete out.filter;
    delete out.aggregate;
    delete out.group;
    delete out.joins;
    // 注意：不能 delete out.join — 上面序列化 joins 会产出 out.join = "product:one:pdt:..."（URL 格式）

    // DEBUG — 临时验证 join 序列化是否生效
    //console.log("[cleanParams] joinsDirect:", joinsDirect, "| joinDirect:", joinDirect, "| out.join:", (out as any).join);

    if (!allowReserved) {
      for (const k of LIST_BLOCKED_KEYS) delete out[k];
    }

    // —— 数组 → 逗号串统一化（fields / groupBy / orderBy 都支持 string | string[]）——
    const joinIfArray = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).join(",") : v;
    out.fields = joinIfArray(out.fields);
    out.groupBy = joinIfArray(out.groupBy);
    out.orderBy = joinIfArray(out.orderBy);

    // orderBy 清理：去空格 + 统一方向为小写
    //   "product_count desc, id ASC" → "product_count:desc,id:asc"
    if (typeof out.orderBy === "string") {
      out.orderBy = out.orderBy
        .split(",")
        .map(s => {
          const trimmed = s.trim();
          // 先把 "col Dir" 空格写法转成 "col:Dir"，再 : 分割方向转小写
          const withColon = trimmed.replace(/\s+/g, ":");
          const [col, dir] = withColon.split(":", 2);
          return dir ? `${col}:${dir.toLowerCase()}` : col;
        })
        .join(",");
    }
    return out;
  }

  const client: FooseClient = {
    loading: false as unknown as boolean, // 下面用 Object.defineProperty 覆盖
    error: null as unknown as string | null,
    get user() {
      return user.value;
    },

    async fooseList<T>(
      object: string,
      table: string,
      params?: FooseListParams
    ) {
      loading.value = true;
      error.value = null;
      try {
        // DEBUG        
        //console.log("[client fooseList] params keys:", Object.keys(params ?? {}), "| joins:", (params as any)?.joins);
        // axios 拦截器已解包，列表接口可能的形态：
        //   分页    { data: [...], meta: {...} }    → 默认 / page/pageSize
        //   nopage  [{...}, {...}]                 → nopage=true
        //   __one   {...}（单对象）                 → __one=true
        const raw = await http.get<unknown, unknown>(`api/${object}/${table}`, {
          params: cleanParams(params) as Record<string, unknown>
        });

        // Case A：后端直接返回纯数组（nopage=true）
        if (Array.isArray(raw)) {
          const arr = raw as T[];
          return {
            data: arr,
            meta: { total: arr.length, page: 0, pageSize: 0, totalPages: 0 }
          } as FoosePage<T>;
        }

        // Case B：后端返回 { data: [...], meta: {...} }（或被拦截器解包后的形态）
        const obj = raw as Record<string, unknown>;

        // 如果拦截器未解包，外层可能是 FooseEnvelope { data: {...}, code, message }
        const inner =
          obj &&
            "data" in obj &&
            !Array.isArray(obj.data) &&
            "meta" in (obj.data as Record<string, unknown>)
            ? (obj.data as { data: T[]; meta: FoosePage<T>["meta"] })
            : (obj as unknown as { data: T[]; meta: FoosePage<T>["meta"] });

        return {
          data: (inner.data as T[] | undefined) ?? [],
          meta: inner.meta,
          sql: (obj as Record<string, unknown>).sql as string | undefined,
          sqlParams: (obj as Record<string, unknown>).sqlParams as unknown[] | undefined
        } as FoosePage<T>;
      } finally {
        loading.value = false;
      }
    },

    async fooseGet<T>(
      object: string,
      table: string,
      id: number | string,
      params?: { fields?: string; join?: string }
    ) {
      loading.value = true;
      error.value = null;
      try {
        const res = await http.get<unknown, T>(`api/${object}/${table}/${id}`, {
          params
        });
        return res as T;
      } finally {
        loading.value = false;
      }
    },

    async fooseGetBy<T>(object: string, table: string, params: FooseListParams) {
      loading.value = true;
      error.value = null;
      try {
        const finalParams = { ...cleanParams(params), __one: true } as Record<string, unknown>;
        const row = await http.get<unknown, T>(`api/${object}/${table}`, { params: finalParams });
        return (row as unknown as T) ?? null;
      } catch (e) {
        // 404 = 没找到 → 返回 null 而不是抛错
        if (e instanceof Error && /404|未找到行/i.test(e.message)) {
          return null;
        }
        throw e;
      } finally {
        loading.value = false;
      }
    },

    async fooseCreate<T>(object: string, table: string, data: FoosePatch<T>) {
      loading.value = true;
      error.value = null;
      try {
        const res = await http.post<unknown, { ok: true; row: T }>(`api/${object}/${table}`, data);
        return res.row;
      } finally {
        loading.value = false;
      }
    },

    async fooseUpdate<T>(
      object: string,
      table: string,
      id: number | string,
      data: FoosePatch<T>
    ) {
      loading.value = true;
      error.value = null;
      try {
        const res = await http.put<unknown, { ok: true; row: T }>(
          `api/${object}/${table}/${id}`,
          data
        );
        return res.row;
      } finally {
        loading.value = false;
      }
    },

    async fooseCreates<T>(object: string, table: string, rows: FoosePatch<T>[], showSql = false) {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("rows must be a non-empty array");
      }
      loading.value = true;
      error.value = null;
      try {
        return await http.post<unknown, { ok: boolean; created: number; rows: T[]; sql?: string; sqlParams?: unknown[] }>(
          `api/${object}/${table}/batch-create${showSql ? "?showSql=1" : ""}`,
          { rows }
        );
      } finally {
        loading.value = false;
      }
    },

    async fooseUpdates<T>(
      object: string,
      table: string,
      rows: Array<{ id: number | string } & FoosePatch<T>>,
      showSql = false
    ) {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("rows must be a non-empty array");
      }
      loading.value = true;
      error.value = null;
      try {
        return await http.post<unknown, { ok: boolean; updated: number; rows: T[]; sql?: string; sqlParams?: unknown[] }>(
          `api/${object}/${table}/batch-update${showSql ? "?showSql=1" : ""}`,
          { rows }
        );
      } finally {
        loading.value = false;
      }
    },

    async fooseRemove(object: string, table: string, id: number | string) {
      loading.value = true;
      error.value = null;
      try {
        const res = await http.delete<unknown, { ok: true; deleted: 1 }>(
          `api/${object}/${table}/${id}`
        );
        return res;
      } finally {
        loading.value = false;
      }
    },

    async fooseRemoves(object: string, table: string, ids: Array<string | number>, showSql = false) {
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new Error("ids must be a non-empty array");
      }
      loading.value = true;
      error.value = null;
      try {
        const res = await http.post<unknown, { ok: boolean; deleted: number; sql?: string; sqlParams?: unknown[] }>(
          `api/${object}/${table}/batch-delete${showSql ? "?showSql=1" : ""}`,
          { ids }
        );
        return res;
      } finally {
        loading.value = false;
      }
    },

    async fooseRemoveByFilter(
      object: string,
      table: string,
      filter: Record<string, unknown>,
      showSql = false
    ) {
      if (!filter || Object.keys(filter).length === 0) {
        throw new Error("filter must be a non-empty object");
      }
      loading.value = true;
      error.value = null;
      try {
        const res = await http.post<unknown, { ok: boolean; deleted: number; sql?: string; sqlParams?: unknown[] }>(
          `api/${object}/${table}/batch-delete-filter${showSql ? "?showSql=1" : ""}`,
          { filter }
        );
        return res;
      } finally {
        loading.value = false;
      }
    },

    async fooseLogin(usernameInput: string, passwordInput: string) {
      loading.value = true;
      error.value = null;
      try {
        // 拦截器已解包外层 data，直接拿到 FooseAuthResponse
        const tokenData = await http.post<unknown, FooseAuthResponse>(
          "api/auth/login",
          { username: usernameInput, password: passwordInput },
          { headers: { "X-Client-Id": fingerprint } }
        );
        saveAuth(storageKey, tokenData);
        auth = loadAuth(storageKey);
        user.value = auth?.user ?? null;
        return tokenData;
      } finally {
        loading.value = false;
      }
    },

    async fooseSafeLogin(usernameInput: string, passwordInput: string) {
      try {
        const data = await this.fooseLogin(usernameInput, passwordInput);
        return { ok: true as const, data };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "登录失败";
        return { ok: false as const, error: msg };
      }
    },

    async fooseLogout() {
      try {
        if (auth?.refresh_token) {
          await http.post("api/auth/logout", {
            refresh_token: auth.refresh_token
          });
        }
      } catch {
        /* 即使后端 logout 失败也继续清本地 */
      }
      clearAuth(storageKey);
      auth = null;
      user.value = null;
    },

    fooseIsAuthenticated() {
      return !!auth && !accessTokenExpired();
    },

    fooseGetCurrentUser() {
      return user.value;
    }
  };

  // —— 把 loading / error / user 做成响应式 getter（不用改 FooseClient 接口类型） ——
  Object.defineProperty(client, "loading", {
    get: () => loading.value,
    configurable: true
  });
  Object.defineProperty(client, "error", {
    get: () => error.value,
    configurable: true
  });
  Object.defineProperty(client, "user", {
    get: () => user.value,
    configurable: true
  });

  return client;
}

/* ================================================================
 * 4. Vue 3 组合式 API —— 依赖上一步的 FooseClient
 * ================================================================ */

/**
 * 组合式函数返回的状态 + 方法（Vue 3 ref 包装）
 */
export interface FooseComposable<T> {
  fooseDbDataList: Ref<T[]>;
  fooseCurrentRow: Ref<T | null>;
  fooseDbLoading: Ref<boolean>;
  fooseDbError: Ref<string | null>;
  fooseDbPage: Ref<number>;
  fooseDbPageSize: Ref<number>;
  fooseDbTotal: Ref<number>;
  fooseDbList: (params?: FooseListParams) => Promise<FoosePage<T>>;
  fooseDbGet: (
    id: number | string,
    fields?: string,
    join?: string
  ) => Promise<T>;
  fooseDbGetBy: (params: FooseListParams) => Promise<T | null>;
  fooseDbCreate: (data: FoosePatch<T>) => Promise<T>;
  fooseDbCreates: (rows: FoosePatch<T>[], showSql?: boolean) => Promise<{ ok: boolean; created: number; rows: T[]; sql?: string; sqlParams?: unknown[] }>;
  fooseDbUpdate: (id: number | string, data: FoosePatch<T>) => Promise<T>;
  fooseDbUpdates: (rows: Array<{ id: number | string } & FoosePatch<T>>, showSql?: boolean) => Promise<{ ok: boolean; updated: number; rows: T[]; sql?: string; sqlParams?: unknown[] }>;
  fooseDbRemove: (id: number | string) => Promise<{ ok: boolean; deleted: number }>;
  fooseDbRemoves: (ids: Array<number | string>, showSql?: boolean) => Promise<{ ok: boolean; deleted: number; sql?: string; sqlParams?: unknown[] }>;
  fooseDbRemovesByFilter: (filter: Record<string, unknown>, showSql?: boolean) => Promise<{ ok: boolean; deleted: number; sql?: string; sqlParams?: unknown[] }>;
  fooseDbReset: () => void;
}

/**
 * 创建一个**组件级**的组合式（每次调用独立状态）
 *
 *   const foose = await createFooseClient({ username: "bob", password: "..." });
 *   const { list, data, loading } = useFoose(foose, "sqlite_demo", "product");
 */
export function useFoose<T extends FooseRow>(
  foose: FooseClient,
  object: string,
  table: string
): FooseComposable<T> {
  const data = ref<T[]>([]);
  const current = ref<T | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const page = ref(1);
  const pageSize = ref(20);
  const total = ref(0);

  async function fooseList(params?: FooseListParams) {
    loading.value = true;
    error.value = null;
    try {
      const res = await foose.fooseList<T>(object, table, params);
      data.value = (res?.data ?? []) as T[];
      page.value = res?.meta?.page ?? 1;
      pageSize.value = res?.meta?.pageSize ?? 20;
      total.value = res?.meta?.total ?? data.value.length;
      return res;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "未知错误";
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function fooseGet(id: number | string, fields?: string, join?: string) {
    loading.value = true;
    error.value = null;
    try {
      const row = await foose.fooseGet<T>(object, table, id, { fields, join });
      current.value = row;
      return row;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "未知错误";
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function fooseGetBy(params: FooseListParams) {
    loading.value = true;
    error.value = null;
    try {
      const row = await foose.fooseGetBy<T>(object, table, params);
      current.value = row;
      return row;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "未知错误";
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function fooseCreate(payload: FoosePatch<T>) {
    loading.value = true;
    error.value = null;
    try {
      const row = await foose.fooseCreate<T>(object, table, payload);
      current.value = row;
      if (data.value.length > 0) (data.value as T[]).unshift(row);
      total.value += 1;
      return row;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "未知错误";
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function fooseUpdate(id: number | string, payload: FoosePatch<T>) {
    loading.value = true;
    error.value = null;
    try {
      const row = await foose.fooseUpdate<T>(object, table, id, payload);
      current.value = row;
      const list = data.value as T[];
      const idx = list.findIndex(r => (r as FooseRow).id === id);
      if (idx !== -1) list.splice(idx, 1, row);
      return row;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "未知错误";
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function fooseRemove(id: number | string) {
    loading.value = true;
    error.value = null;
    try {
      const res = await foose.fooseRemove(object, table, id);
      data.value = (data.value as T[]).filter(r => (r as FooseRow).id !== id);
      if ((current.value as FooseRow | null)?.id === id) current.value = null;
      total.value = Math.max(0, total.value - 1);
      return res;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "未知错误";
      throw e;
    } finally {
      loading.value = false;
    }
  }

  function fooseReset() {
    data.value = [];
    current.value = null;
    error.value = null;
    page.value = 1;
    pageSize.value = 20;
    total.value = 0;
  }

  return {
    data,
    current,
    loading,
    error,
    page,
    pageSize,
    total,
    fooseList,
    fooseGet,
    fooseGetBy,
    fooseCreate,
    fooseUpdate,
    fooseRemove,
    fooseReset
  } as unknown as FooseComposable<T>;
}

/**
 * 预定义业务组合式工厂（全局复用同一个 foose 实例）
 *
 *   const foose = await createFooseClient({ ... });
 *   const useProduct = createUseFooseTable<ProductRow>(foose, "sqlite_demo", "product");
 *
 *   // 业务页面
 *   const { list, data } = useProduct();
 */
export function createUseFooseTable<T extends FooseRow>(
  foose: FooseClient,
  object: string,
  table: string
) {
  return () => useFoose<T>(foose, object, table);
}

/* ================================================================
 * 5. 快速用法示例（业务前端 main.ts 或某个 composable 文件里）
 *
 *   // main.ts（只初始化一次）
 *   import { createFooseClient } from "@/api/foose_db";
 *
 *   const foose = await createFooseClient({
 *     baseURL: "http://127.0.0.1:8858",
 *     // 不传 username/password → 匿名访问
 *     // username: "bob",
 *     // password: "123456",
 *   });
 *
 *   // 存到 window 或 Pinia，组件里用
 *   (window as unknown as Record<string, unknown>).foose = foose;
 *
 *   // 某个业务组件
 *   import { useFoose } from "@/api/foose_db";
 *   const foose = (window as unknown as Record<string, unknown>).foose as FooseClient;
 *   const { list, data, loading, error } = useFoose(foose, "sqlite_demo", "product");
 *   await list({ page: 1, pageSize: 50 });
 *
 *   // 纯 JS 上下文（router guard / store）—— 直接用 foose.list()
 *   const page = await foose.list("sqlite_demo", "product", { page: 1 });
 * ================================================================ */
