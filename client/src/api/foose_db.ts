/**
 * FoosDB 通用客户端 SDK —— 完全独立、零业务耦合
 * ===================================================================
 *
 * ✅ 独立成 npm 包：整个文件只依赖 axios + Vue 3（ref），
 *    不 import 任何业务模块（如 demo/foose_base、admin-vue 内部路由等）。
 *
 * 四层 API（从底层到业务层）：
 * ────────────────────────────────────────────────────────────────────
 *
 *   Layer 1  createFooseClient(options)  ← SDK 提供
 *   │         初始化 axios + 强制登录 + token 自动 refresh
 *   │         返回 FooseClient 实例
 *   │
 *   Layer 2  foose.fooseList/Get/Create/Update/Remove  ← FooseClient 实例方法
 *   │         低级 HTTP 调用，非 Vue 上下文可用（router guard / store）
 *   │
 *   Layer 3  useFoose<T>(foose, object, table)  ← SDK 提供
 *   │         Vue 组合式，自动维护 data[]/loading/error + unshift/splice/filter 副作用
 *   │         需外部先持有 FooseClient 实例
 *   │
 *   Layer 4  createUseFoose<T>(config, getFoose)  ← SDK 提供
 *             表级工厂，一行代码生成 useXxx composable
 *             把 object+table 封进闭包，getFoose 由业务层注入
 *             （业务 *_api.ts 用的就是这一层）
 *
 * 业务层桥接（demo/foose_base.ts，**不属于 SDK**）：
 * ────────────────────────────────────────────────────────────────────
 *   // SDK 只提供工具，业务层自己管理客户端单例
 *   let _instance: FooseClient | null = null;
 *   export async function importFooseClient(): Promise<FooseClient> {
 *     if (_instance) return _instance;
 *     _instance = await createFooseClient({
 *       baseURL: "http://127.0.0.1:8858",
 *       username: "demo",
 *       password: "admin123456"
 *     });
 *     return _instance;
 *   }
 *
 *   // *_api.ts（业务表定义，**不属于 SDK**）
 *   export const useProduct = createUseFoose<ProductRow>(
 *     { object: "sqlite_demo", table: "foose_product" },
 *     importFooseClient   // ← 注入业务层的 getter，SDK 不关心里面怎么实现
 *   );
 *
 * 四种用法速查：
 * ────────────────────────────────────────────────────────────────────
 *
 *   // A. 纯函数上下文（router guard / store）
 *   const foose = await createFooseClient({ baseURL, username, password });
 *   const page = await foose.fooseList("sqlite_demo", "product", { page: 1 });
 *   //   page.data → T[]
 *   //   page.meta → { total, page, pageSize, totalPages }
 *
 *   // B. Vue 组件内（已持有 foose 实例）
 *   const { fooseList, fooseCreate, data, loading, error }
 *     = useFoose<Product>(foose, "sqlite_demo", "product");
 *   await fooseList({ page: 1, pageSize: 20 });
 *   //   data.value   → Product[]（自动被 list/create/update/remove 同步）
 *   //   loading.value → boolean（请求中自动 true/false）
 *   //   error.value  → string | null（失败自动 set，不会 throw 崩页面）
 *
 *   // C. 业务表级 composable（推荐 *_api.ts 里用）
 *   //   export const useProduct = createUseFoose<ProductRow>(
 *   //     { object: "sqlite_demo", table: "foose_product" },
 *   //     importFooseClient
 *   //   );
 *   const { listResult, loading, errorInfo, getPageList, create, remove } = useProduct();
 *   await getPageList({ page: 1 });
 *   await create({ product_name: "新商品" });
 *   await remove(42);
 *
 *   // D. 认证控制（都在 FooseClient 上）
 *   await foose.fooseLogin("bob", "wrong");     // throw on fail
 *   await foose.fooseSafeLogin("alice", "wrong"); // { ok, data?, error? }
 *   await foose.fooseLogout();
 *   foose.fooseIsAuthenticated();   // boolean
 *   foose.fooseGetCurrentUser();   // { id, username, ... } | null
 *
 * 依赖：axios（必须）、Vue 3（ref — 仅 Layer 3/4 组合式用；Layer 1/2 纯函数不依赖）
 */
import Axios, {
  type AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig
} from "axios";
import { ref, type Ref } from "vue";
import { http } from "@/utils/foose_db_http";
import { v4 as uuidv4 } from "uuid";

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

/** 角色简要信息（与后端 RoleBrief 对齐） */
export interface RoleBrief {
  id: number;
  role_name: string;
  flag: number; // 0=启用, 1=禁用
}

/** 登录/刷新返回的 token 对（后端原始 payload） */
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
    /** RoleBrief[] 对象数组（后端 attachRoles 返回） */
    roles: RoleBrief[];
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
  ): Promise<{
    ok: boolean;
    created: number;
    rows: T[];
    sql?: string;
    sqlParams?: unknown[];
  }>;
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
  ): Promise<{
    ok: boolean;
    updated: number;
    rows: T[];
    sql?: string;
    sqlParams?: unknown[];
  }>;
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
  ): Promise<{
    ok: boolean;
    deleted: number;
    sql?: string;
    sqlParams?: unknown[];
  }>;
  /** 批量按 filter 删除（POST /batch-delete-filter） —— 复用查询 filter 语法 */
  fooseRemoveByFilter(
    object: string,
    table: string,
    filter: Record<string, unknown>,
    showSql?: boolean
  ): Promise<{
    ok: boolean;
    deleted: number;
    sql?: string;
    sqlParams?: unknown[];
  }>;

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
        // 协议信封（Fastify 包装）：外层 { data: {...} } 或 { data: [...] }
        //   - data 是非 null 对象 → 内层可能是 { access_token, refresh_token, ... }（auth）
        //     或 { rows, ... }（admin/db query）→ 解包拿内层对象
        //   - data 是数组 → 纯业务返回 → 不解包
        // 注意：可能同时有 durationMs / sqlParams 等额外字段（debug 插件注入），
        // 所以不能再用 Object.keys(body).length === 1 这种脆弱启发式！
        if (
          "data" in body &&
          body.data !== null &&
          typeof body.data === "object" &&
          !Array.isArray(body.data)
        ) {
          return body.data;
        }
        // 管理端 admin 路由返回 { ok, ... } / 通用 CRUD 返回 { data:[], meta:{...} }
        // 这些业务信封保留完整
        if ("ok" in body || "total" in body || "meta" in body) return body;
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
              flattenBracket(
                item as Record<string, unknown>,
                `${key}[${i}]`,
                out
              );
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
    const { filter, aggregate, group, ...rest } = params as FooseListParams & {
      join?: FooseJoin[];
    };
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
        Object.assign(
          out,
          flattenBracket(group.having as Record<string, unknown>, "having")
        );
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
      Array.isArray(v)
        ? v
            .map(x => String(x).trim())
            .filter(Boolean)
            .join(",")
        : v;
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
          sqlParams: (obj as Record<string, unknown>).sqlParams as
            unknown[] | undefined
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

    async fooseGetBy<T>(
      object: string,
      table: string,
      params: FooseListParams
    ) {
      loading.value = true;
      error.value = null;
      try {
        const finalParams = { ...cleanParams(params), __one: true } as Record<
          string,
          unknown
        >;
        const row = await http.get<unknown, T>(`api/${object}/${table}`, {
          params: finalParams
        });
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
        const res = await http.post<unknown, { ok: true; row: T }>(
          `api/${object}/${table}`,
          data
        );
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

    async fooseCreates<T>(
      object: string,
      table: string,
      rows: FoosePatch<T>[],
      showSql = false
    ) {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("rows must be a non-empty array");
      }
      loading.value = true;
      error.value = null;
      try {
        return await http.post<
          unknown,
          {
            ok: boolean;
            created: number;
            rows: T[];
            sql?: string;
            sqlParams?: unknown[];
          }
        >(`api/${object}/${table}/batch-create${showSql ? "?showSql=1" : ""}`, {
          rows
        });
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
        return await http.post<
          unknown,
          {
            ok: boolean;
            updated: number;
            rows: T[];
            sql?: string;
            sqlParams?: unknown[];
          }
        >(`api/${object}/${table}/batch-update${showSql ? "?showSql=1" : ""}`, {
          rows
        });
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

    async fooseRemoves(
      object: string,
      table: string,
      ids: Array<string | number>,
      showSql = false
    ) {
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new Error("ids must be a non-empty array");
      }
      loading.value = true;
      error.value = null;
      try {
        const res = await http.post<
          unknown,
          { ok: boolean; deleted: number; sql?: string; sqlParams?: unknown[] }
        >(`api/${object}/${table}/batch-delete${showSql ? "?showSql=1" : ""}`, {
          ids
        });
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
        const res = await http.post<
          unknown,
          { ok: boolean; deleted: number; sql?: string; sqlParams?: unknown[] }
        >(
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
  fooseDbCreates: (
    rows: FoosePatch<T>[],
    showSql?: boolean
  ) => Promise<{
    ok: boolean;
    created: number;
    rows: T[];
    sql?: string;
    sqlParams?: unknown[];
  }>;
  fooseDbUpdate: (id: number | string, data: FoosePatch<T>) => Promise<T>;
  fooseDbUpdates: (
    rows: Array<{ id: number | string } & FoosePatch<T>>,
    showSql?: boolean
  ) => Promise<{
    ok: boolean;
    updated: number;
    rows: T[];
    sql?: string;
    sqlParams?: unknown[];
  }>;
  fooseDbRemove: (
    id: number | string
  ) => Promise<{ ok: boolean; deleted: number }>;
  fooseDbRemoves: (
    ids: Array<number | string>,
    showSql?: boolean
  ) => Promise<{
    ok: boolean;
    deleted: number;
    sql?: string;
    sqlParams?: unknown[];
  }>;
  fooseDbRemovesByFilter: (
    filter: Record<string, unknown>,
    showSql?: boolean
  ) => Promise<{
    ok: boolean;
    deleted: number;
    sql?: string;
    sqlParams?: unknown[];
  }>;
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
 * 5. 表级工厂 —— createUseFoose / createFooseApi
 *
 * 与上面 useFoose(foose, object, table) 的区别：
 *   useFoose       — 需要外部持有 FooseClient 实例，适合已初始化的场景
 *   createUseFoose — 把 object+table+defaultPageSize 封装成闭包，
 *                    业务层 *_api.ts 里一行就能生成 useProduct()
 *
 * SDK 解耦设计：
 *   getFoose 参数让 SDK 不关心客户端怎么初始化（单例？每次新建？SSR？），
 *   也不硬编码任何业务层的 object 默认值。业务层通过
 *   demo/foose_base.ts 的 importFooseClient 注入实际实现。
 * ================================================================ */

/** 表级工厂配置 */
export interface FooseTableConfig {
  /** 后端 object/datasource 名（必填，SDK 层不设默认） */
  object: string;
  /**
   * 后端真实表名 —— 同时用于自动推导 prefix：
   *   "foose_product"      → 自动推 prefix = "product"
   *   "foose_product_type" → 自动推 prefix = "productType"
   *   "users"              → 自动推 prefix = "users"
   */
  table: string;
  /** 默认分页大小（默认 10） */
  defaultPageSize?: number;
  /**
   * key 前缀 —— 覆盖 table 的自动推导结果（默认会自动推导，一般不用传）
   *   自动推导: table "foose_product_type" → prefix = "productType"
   *   覆盖传值: prefix = "pt" → ptList, ptLoading, ...
   */
  prefix?: string;
}

/**
 * 从表名自动推导 prefix（运行时）：
 *   foose_product_type → productType  （去掉 foose_ 前缀 + _ 驼峰化）
 *   product_type       → productType
 *   users              → users
 *   foose_user_role    → userRole
 */
export function derivePrefix(table: string): string {
  const stripped = table
    .replace(/^foose_/, "")
    .replace(/^t_/, "")
    .replace(/^tbl_/, "");
  return stripped
    .split("_")
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

/**
 * 从表名推导 prefix（类型版）
 *   DerivePrefixType<"foose_product_type"> → "productType"
 *   DerivePrefixType<"users">              → "users"
 */
export type DerivePrefixType<Table extends string> =
  Table extends `foose_${infer Rest}`
    ? DerivePrefixTypeInner<Rest>
    : Table extends `t_${infer Rest}`
      ? DerivePrefixTypeInner<Rest>
      : Table extends `tbl_${infer Rest}`
        ? DerivePrefixTypeInner<Rest>
        : DerivePrefixTypeInner<Table>;

type DerivePrefixTypeInner<S extends string> =
  S extends `${infer First}_${infer Rest}`
    ? `${First}${Capitalize<DerivePrefixTypeInner<Rest>>}`
    : S;

/**
 * 类型层：把 FooseComposable 的原始 key 直接变成干净的语义名
 *
 * 特殊映射（与 renameKeys 运行时一致）：
 *   fooseDbDataList  → listResult
 *   fooseDbError     → errorInfo
 *   fooseDbList      → getPageList
 *   fooseDbGet       → getRow
 *
 * 通用规则（strip fooseDb / foose 前缀）：
 *   fooseDbLoading   → loading
 *   fooseDbPage      → page
 *   fooseDbCreate    → create
 *   fooseCurrentRow  → currentRow（foose 前缀无 Db 所以走 Uncapitalize<CurrentRow> → currentRow）
 *
 * 可选 Prefix：同组件多表不冲突时开启
 *   CleanKey<"fooseDbList", "product"> → "productGetPageList"
 */
type CleanKey<
  K extends string,
  Prefix extends string = ""
> = K extends "fooseDbDataList"
  ? `${Prefix}listResult`
  : K extends "fooseDbError"
    ? `${Prefix}errorInfo`
    : K extends "fooseDbList"
      ? `${Prefix}getPageList`
      : K extends "fooseDbGet"
        ? `${Prefix}getRow`
        : K extends `fooseDb${infer Rest}`
          ? `${Prefix}${Uncapitalize<Rest>}`
          : K extends `foose${infer Rest}`
            ? `${Prefix}${Uncapitalize<Rest>}`
            : `${Prefix}${K}`;

/** 干净 key 的 Composable — 默认 Prefix=""，key 就是 listResult/errorInfo/getPageList/getRow/loading/page/create/... */
export type CleanComposable<T extends FooseRow, Prefix extends string = ""> = {
  [
    K in keyof FooseComposable<T> as CleanKey<Extract<K, string>, Prefix>
  ]: FooseComposable<T>[K];
};

/**
 * 强制 TypeScript 把泛型别名 / MappedType 展开成具体结构。
 */
export type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

/** 内部：懒加载 foose 单例 + 错误处理 */
function makeFooseGetter(
  getFoose: () => Promise<FooseClient>,
  errorRef: Ref<string | null>
) {
  let promise: Promise<FooseClient> | null = null;
  return function (): Promise<FooseClient> {
    if (!promise) {
      promise = getFoose().catch(err => {
        errorRef.value = err instanceof Error ? err.message : "FoosDB 连接失败";
        throw err;
      });
    }
    return promise;
  };
}

/**
 * 特殊 key 映射表（SDK 内部名 → 对外规范名）：
 *   fooseDbDataList  → listResult    列表结果（Ref<T[]>）
 *   fooseDbError     → errorInfo     错误信息（Ref<string | null>）
 *   fooseDbList      → getPageList   分页列表（方法）
 *   fooseDbGet       → getRow        按 ID 取单条（方法）
 */
const SPECIAL_KEY_MAP: Record<string, string> = {
  fooseDbDataList: "listResult",
  fooseDbError: "errorInfo",
  fooseDbList: "getPageList",
  fooseDbGet: "getRow"
};

/**
 * 把 composable 的原始 key 重命名为干净的语义名：
 *   fooseDbDataList         → listResult   （特殊映射）
 *   fooseDbError            → errorInfo    （特殊映射）
 *   fooseDbList             → getPageList  （特殊映射）
 *   fooseDbGet              → getRow       （特殊映射）
 *   fooseDbLoading          → loading
 *   fooseDbPage             → page
 *   fooseDbPageSize         → pageSize
 *   fooseDbTotal            → total
 *   fooseCurrentRow         → currentRow   （无 Db 前缀，不走 strip）
 *   fooseDbCreate           → create
 *   fooseDbCreates          → creates
 *   fooseDbUpdate           → update
 *   fooseDbUpdates          → updates
 *   fooseDbRemove           → remove
 *   fooseDbRemoves          → removes
 *   fooseDbRemovesByFilter  → removesByFilter
 *   fooseDbReset            → reset
 *
 * 可选 prefix 参数（同组件多表不冲突时开启）：
 *   renameKeys(obj, "product") → productListResult, productLoading, ...
 */
function renameKeys(
  obj: Record<string, unknown>,
  prefix: string = ""
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // 1. 先试特殊映射表
    if (SPECIAL_KEY_MAP[k]) {
      out[prefix + SPECIAL_KEY_MAP[k]] = v;
      continue;
    }
    // 2. 通用：fooseDbXxx → xxx，fooseXxx → xxx
    let key = k.startsWith("foose") ? k.slice(5) : k;
    if (key.startsWith("Db")) key = key.slice(2);
    out[prefix + key.charAt(0).toLowerCase() + key.slice(1)] = v;
  }
  return out;
}

/**
 * 创建响应式 composable（useProduct / useProductType ...）
 *
 *   import { createUseFoose } from "@/api/foose_db";
 *   import { importFooseClient } from "@/api/demo/foose_base";
 *
 *   export const useProduct = createUseFoose<ProductRow>(
 *     { object: "sqlite_demo", table: "foose_product", defaultPageSize: 10 },
 *     importFooseClient   // ← 业务层注入 FooseClient getter
 *   );
 *
 *   // 组件里：
 *   const { listResult, loading, errorInfo, getPageList, create, remove } = useProduct();
 */
export function createUseFoose<T extends FooseRow, Prefix extends string = "">(
  config: FooseTableConfig,
  getFoose: () => Promise<FooseClient>
): () => CleanComposable<T, Prefix> {
  const OBJECT = config.object;
  const TABLE = config.table;
  const DEFAULT_PAGE_SIZE = config.defaultPageSize ?? 10;
  const prefix: string = config.prefix ?? "";

  return function useFooseTable(): CleanComposable<T, Prefix> {
    // —— 响应式状态（必须在 setup 顶层同步创建）——
    const data: Ref<T[]> = ref([]);
    const current: Ref<T | null> = ref(null);
    const loading = ref(false);
    const error: Ref<string | null> = ref(null);
    const page = ref(1);
    const pageSize = ref(DEFAULT_PAGE_SIZE);
    const total = ref(0);

    const getClient = makeFooseGetter(getFoose, error);

    async function fooseList(params?: FooseListParams) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getClient();
        const res = await foose.fooseList<T>(OBJECT, TABLE, params);
        data.value = (res?.data ?? []) as T[];
        page.value = res?.meta?.page ?? 1;
        pageSize.value = res?.meta?.pageSize ?? DEFAULT_PAGE_SIZE;
        total.value = res?.meta?.total ?? data.value.length;
        return res;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseGet(
      id: number | string,
      fields?: string,
      join?: string
    ) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getClient();
        const row = await foose.fooseGet<T>(OBJECT, TABLE, id, {
          fields,
          join
        });
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
        const foose = await getClient();
        const row = await foose.fooseGetBy<T>(OBJECT, TABLE, params);
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
        const foose = await getClient();
        const row = await foose.fooseCreate<T>(OBJECT, TABLE, payload);
        current.value = row;
        data.value.unshift(row);
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
        const foose = await getClient();
        const row = await foose.fooseUpdate<T>(OBJECT, TABLE, id, payload);
        current.value = row;
        const idx = data.value.findIndex(r => {
          const rk =
            (r as Record<string, unknown>).id ??
            (r as Record<string, unknown>).my_id;
          return rk === id;
        });
        if (idx !== -1) data.value.splice(idx, 1, row);
        return row;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseCreates(payloads: FoosePatch<T>[], showSql = false) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getClient();
        const res = await foose.fooseCreates<T>(
          OBJECT,
          TABLE,
          payloads,
          showSql
        );
        for (const row of res.rows) {
          data.value.unshift(row);
        }
        total.value += res.created;
        return res;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseUpdates(
      rows: Array<{ id: number | string } & FoosePatch<T>>,
      showSql = false
    ) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getClient();
        const res = await foose.fooseUpdates<T>(OBJECT, TABLE, rows, showSql);
        for (const newRow of res.rows) {
          const r = newRow as Record<string, unknown>;
          const id = r.id ?? r.my_id;
          if (id !== undefined) {
            const idx = data.value.findIndex(
              d =>
                (d as Record<string, unknown>).id === id ||
                (d as Record<string, unknown>).my_id === id
            );
            if (idx !== -1) data.value.splice(idx, 1, newRow);
          }
        }
        return res;
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
        const foose = await getClient();
        const res = await foose.fooseRemove(OBJECT, TABLE, id);
        data.value = data.value.filter(r => {
          const rk =
            (r as Record<string, unknown>).id ??
            (r as Record<string, unknown>).my_id;
          return rk !== id;
        });
        if (current.value) {
          const ck =
            (current.value as Record<string, unknown>).id ??
            (current.value as Record<string, unknown>).my_id;
          if (ck === id) current.value = null;
        }
        total.value = Math.max(0, total.value - 1);
        return res;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseRemoves(ids: Array<number | string>, showSql = false) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getClient();
        const res = await foose.fooseRemoves(OBJECT, TABLE, ids, showSql);
        const idSet = new Set(ids);
        data.value = data.value.filter(r => {
          const rk =
            (r as Record<string, unknown>).id ??
            (r as Record<string, unknown>).my_id;
          return !idSet.has(rk as number | string);
        });
        if (current.value) {
          const ck =
            (current.value as Record<string, unknown>).id ??
            (current.value as Record<string, unknown>).my_id;
          if (idSet.has(ck as number | string)) current.value = null;
        }
        total.value = Math.max(0, total.value - (res?.deleted ?? ids.length));
        return res;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseRemovesByFilter(
      filter: Record<string, unknown>,
      showSql = false
    ) {
      error.value = null;
      try {
        const foose = await getClient();
        return foose.fooseRemoveByFilter(OBJECT, TABLE, filter, showSql);
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      }
    }

    function fooseReset() {
      data.value = [];
      current.value = null;
      error.value = null;
      page.value = 1;
      pageSize.value = DEFAULT_PAGE_SIZE;
      total.value = 0;
    }

    const raw: FooseComposable<T> = {
      fooseDbDataList: data,
      fooseCurrentRow: current,
      fooseDbLoading: loading,
      fooseDbError: error,
      fooseDbPage: page,
      fooseDbPageSize: pageSize,
      fooseDbTotal: total,
      fooseDbList: fooseList,
      fooseDbGet: fooseGet,
      fooseDbGetBy: fooseGetBy,
      fooseDbCreate: fooseCreate,
      fooseDbCreates: fooseCreates,
      fooseDbUpdate: fooseUpdate,
      fooseDbUpdates: fooseUpdates,
      fooseDbRemove: fooseRemove,
      fooseDbRemoves: fooseRemoves,
      fooseDbRemovesByFilter: fooseRemovesByFilter,
      fooseDbReset: fooseReset
    };

    const result = renameKeys(
      raw as unknown as Record<string, unknown>,
      prefix
    );
    return result as CleanComposable<T, Prefix>;
  };
}

/* ==================== 纯函数 API ==================== */

/** 纯函数 API 接口 — 不走响应式状态，用于 store / router guard / 工具函数 */
export interface FooseApi<T extends FooseRow> {
  list: (params?: FooseListParams) => Promise<FoosePage<T>>;
  get: (id: number | string, fields?: string, join?: string) => Promise<T>;
  getBy: (params: FooseListParams) => Promise<T | null>;
  create: (payload: FoosePatch<T>) => Promise<T>;
  creates: (
    rows: FoosePatch<T>[],
    showSql?: boolean
  ) => Promise<{
    ok: boolean;
    created: number;
    rows: T[];
    sql?: string;
    sqlParams?: unknown[];
  }>;
  update: (id: number | string, payload: FoosePatch<T>) => Promise<T>;
  updates: (
    rows: Array<{ id: number | string } & FoosePatch<T>>,
    showSql?: boolean
  ) => Promise<{
    ok: boolean;
    updated: number;
    rows: T[];
    sql?: string;
    sqlParams?: unknown[];
  }>;
  remove: (id: number | string) => Promise<{ ok: boolean; deleted: number }>;
  removes: (
    ids: Array<string | number>,
    showSql?: boolean
  ) => Promise<{
    ok: boolean;
    deleted: number;
    sql?: string;
    sqlParams?: unknown[];
  }>;
  removeByFilter: (
    filter: Record<string, unknown>,
    showSql?: boolean
  ) => Promise<{
    ok: boolean;
    deleted: number;
    sql?: string;
    sqlParams?: unknown[];
  }>;
}

/**
 * 创建纯函数 API（store / router guard / 工具函数里用）
 *
 * 与 createUseFoose 的区别：
 *   createUseFoose → 返回带 loading/error/dataList 响应式状态的 composable
 *   createFooseApi → 返回 10 个纯函数，无状态，每次调用都是独立请求
 *
 * 注：getFoose 由业务层注入（一般是 importFooseClient）。
 */
export function createFooseApi<T extends FooseRow>(
  config: FooseTableConfig,
  getFoose: () => Promise<FooseClient>
): FooseApi<T> {
  const OBJECT = config.object;
  const TABLE = config.table;

  async function list(params?: FooseListParams) {
    const foose = await getFoose();
    return foose.fooseList<T>(OBJECT, TABLE, params);
  }
  async function get(id: number | string, fields?: string, join?: string) {
    const foose = await getFoose();
    return foose.fooseGet<T>(OBJECT, TABLE, id, { fields, join });
  }
  async function getBy(params: FooseListParams) {
    const foose = await getFoose();
    return foose.fooseGetBy<T>(OBJECT, TABLE, params);
  }
  async function create(payload: FoosePatch<T>) {
    const foose = await getFoose();
    return foose.fooseCreate<T>(OBJECT, TABLE, payload);
  }
  async function creates(rows: FoosePatch<T>[], showSql = false) {
    const foose = await getFoose();
    return foose.fooseCreates<T>(OBJECT, TABLE, rows, showSql);
  }
  async function update(id: number | string, payload: FoosePatch<T>) {
    const foose = await getFoose();
    return foose.fooseUpdate<T>(OBJECT, TABLE, id, payload);
  }
  async function updates(
    rows: Array<{ id: number | string } & FoosePatch<T>>,
    showSql = false
  ) {
    const foose = await getFoose();
    return foose.fooseUpdates<T>(OBJECT, TABLE, rows, showSql);
  }
  async function remove(id: number | string) {
    const foose = await getFoose();
    return foose.fooseRemove(OBJECT, TABLE, id);
  }
  async function removes(ids: Array<string | number>, showSql = false) {
    const foose = await getFoose();
    return foose.fooseRemoves(OBJECT, TABLE, ids, showSql);
  }
  async function removeByFilter(
    filter: Record<string, unknown>,
    showSql = false
  ) {
    const foose = await getFoose();
    return foose.fooseRemoveByFilter(OBJECT, TABLE, filter, showSql);
  }

  return {
    list,
    get,
    getBy,
    create,
    creates,
    update,
    updates,
    remove,
    removes,
    removeByFilter
  };
}

/* ================================================================
 * Layer 5 · pure-admin 适配层（FooseDB → pure-admin store）
 * =================================================================
 * getLogin / refreshTokenApi / getMine / getMineLogs
 * 独立文件原本是 foose_db_user.ts，2026-09-22 合并进 foose_db.ts
 * （唯一消费方 store/modules/user.ts 的 import 路径同步改为本文件）
 * ================================================================ */

export type UserResult = {
  code: number;
  message: string;
  data: {
    /** 头像 */
    avatar: string;
    /** 用户名 */
    username: string;
    /** 昵称 */
    nickname: string;
    /** 当前登录用户的角色 */
    roles: Array<string>;
    /** 按钮级别权限 */
    permissions: Array<string>;
    /** `token` */
    accessToken: string;
    /** 用于调用刷新`accessToken`的接口时所需的`token` */
    refreshToken: string;
    /** `accessToken`的过期时间（ISO 字符串） */
    expires: string;
    /** accessToken 过期时间（ISO 字符串，供 pure-admin setToken 使用） */
    refreshExpires?: string;
    /** admin-panel 识别标识（可选，admin 面板 JWT 带 scope） */
    scope?: string;
    /** JWT payload 中的 object_id（-1=admin，≥1=绑定项目） */
    objectId?: number;
    /** 用户ID */
    userId?: number;
    /** 扩展信息 */
    extended?: string;
    /** 邮箱 */
    email?: string;
    /** 联系电话 */
    phone?: string;
  };
};

export type RefreshTokenResult = {
  code: number;
  message: string;
  data: {
    /** `token` */
    accessToken: string;
    /** 用于调用刷新`accessToken`的接口时所需的`token` */
    refreshToken: string;
    /** `accessToken`的过期时间（ISO 字符串） */
    expires: string;
  };
};

export type UserInfo = {
  /** 头像 */
  avatar: string;
  /** 用户名 */
  username: string;
  /** 昵称 */
  nickname: string;
  /** 邮箱 */
  email: string;
  /** 联系电话 */
  phone: string;
  /** 简介 */
  description: string;
  /** 用户ID */
  id: number;
  /** 扩展信息 */
  extended: string;
  /** 按钮级别权限 */
  permissions: Array<string>;
  /** 角色 */
  roles: Array<string>;
};

export type UserInfoResult = {
  code: number;
  message: string;
  data: UserInfo;
};

type ResultTable = {
  code: number;
  message: string;
  data?: {
    /** 列表数据 */
    list: Array<any>;
    /** 总条目数 */
    total?: number;
    /** 每页显示条目个数 */
    pageSize?: number;
    /** 当前页数 */
    currentPage?: number;
  };
};

/** 解码 JWT payload（base64url 解码，纯函数） */
function decodeJwtPayload(token: string): any {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "="
    );
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * 登录（对接 FoosDB /api/auth/login）
 * 后端返回 { data: { access_token, refresh_token, expires, refresh_expires, user } }
 * 前端适配为 pure-admin store 期望的：{ code: 0, data: { accessToken, expires, ... } }
 *
 * roles 处理（2026-09-22）：
 *   后端 user.roles 返回 RoleBrief[] 对象数组（{id, role_name, flag}），
 *   admin-panel 分支 scope==="admin-panel" 时前端固定给 ["admin"]，
 *   否则转 role_name 字符串数组（匹配 UserResult.roles: Array<string>）。
 */
export const getLogin = (data: { username: string; password: string }) => {
  return http
    .request<{ data: any }>("post", "/api/auth/login", {
      data: { username: data.username, password: data.password }
    })
    .then(raw => {
      const d = (raw as any).data;
      if (!d || !d.access_token) {
        throw new Error("登录响应缺少 access_token");
      }

      const payload = decodeJwtPayload(d.access_token);
      const scope: string | undefined = payload?.scope;
      const objectId: number | undefined = payload?.object_id;
      const jwtUsername: string = payload?.username ?? data.username;
      const nickname: string = payload?.nickname ?? jwtUsername;

      const rawRoles = d.user.roles;
      let roleDetails: Array<{ id: number; role_name: string; flag: number }> =
        [];
      let userRoles: Array<string> = [];
      if (Array.isArray(rawRoles)) {
        roleDetails = rawRoles
          .filter((r: any) => typeof r === "object")
          .map((r: any) => ({
            id: r.id ?? 0,
            role_name: r.role_name ?? String(r.id ?? r),
            flag: Number(r.flag ?? 0)
          }));
        userRoles = roleDetails.map(r => r.role_name);
        if (scope === "admin-panel") {
          userRoles = ["admin"];
        }
      } else if (typeof rawRoles === "string" && rawRoles.length > 0) {
        userRoles = rawRoles.split(",").filter(Boolean);
      }

      const user_result = {
        code: 0,
        message: "ok",
        data: {
          accessToken: d.access_token,
          refreshToken: d.refresh_token,
          expires: new Date(d.expires * 1000).toISOString(),
          refreshExpires: new Date(d.refresh_expires * 1000).toISOString(),
          avatar: d.user.avatar || "",
          userId: d.user.id || 0,
          username: jwtUsername,
          nickname,
          extended: d.user.extended || "",
          email: d.user.email || "",
          phone: d.user.phone || "",
          roles: userRoles,
          permissions:
            scope === "admin-panel" ? ["*:*:*"] : [d.user.permissions || ""],
          roleDetails,
          scope,
          objectId
        }
      } as UserResult & { data: { roleDetails: typeof roleDetails } };
      return user_result;
    });
};

/**
 * 刷新 token（对接 FoosDB /api/auth/refresh）
 * 后端请求体 snake_case（refresh_token），pure-admin store 传 camelCase — 这里做转换。
 */
export const refreshTokenApi = (data?: { refreshToken?: string }) => {
  return http
    .request<{ data: any }>("post", "/api/auth/refresh", {
      data: { refresh_token: data?.refreshToken }
    })
    .then(raw => {
      const d = (raw as any).data;
      if (!d || !d.access_token) {
        throw new Error("刷新响应缺少 access_token");
      }
      return {
        code: 0,
        message: "ok",
        data: {
          accessToken: d.access_token,
          refreshToken: d.refresh_token,
          expires: new Date(d.expires * 1000).toISOString()
        }
      } as RefreshTokenResult;
    });
};

/** 账户设置-个人信息（暂未对接，返回空壳） */
export const getMine = (_data?: object): Promise<UserInfoResult> => {
  return Promise.resolve({
    code: 0,
    message: "ok",
    data: {
      avatar: "",
      username: "",
      nickname: "",
      email: "",
      phone: "",
      description: "",
      id: 0,
      extended: "",
      permissions: [],
      roles: []
    }
  });
};

/** 账户设置-个人安全日志（暂未对接） */
export const getMineLogs = (_data?: object): Promise<ResultTable> => {
  return Promise.resolve({
    code: 0,
    message: "ok",
    data: { list: [], total: 0 }
  });
};

/* ================================================================
 * Layer 6 · FooseTools 工具类
 * ===========================
 * uuidv4 / clearAllSpace / generatePassword / toNumber|toBoolean|...
 * 独立文件原本是 foose_db_tools.ts，2026-09-22 合并进 foose_db.ts
 * ================================================================ */

class FooseTools {
  /** 字符池，和校验正则保持一致——用于 generatePassword 保底 */
  static CHAR_POOL = {
    letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    digits: "0123456789",
    specials: "!@#$%^&*()_+{}[]:;|.<>/?"
  };
  /** 生成带 "id" 前缀的 uuidv4（连字符已去掉） */
  static createUuid(): string {
    return "id" + uuidv4().replaceAll("-", "");
  }
  static toNumber(v: number | string): number {
    return Number(v);
  }
  static toString(v: number | string): string {
    return String(v);
  }
  static toBoolean(v: number | string): boolean {
    return Boolean(v);
  }
  static toDate(v: number | string): Date {
    return new Date(v);
  }
  /** 去掉所有空白字符（含全角空格 \u3000）并 trim */
  static clearAllSpace(v: string): string {
    if (!v) return "";
    return v.replace(/[\s\u3000]+/g, "").trim();
  }
  /**
   * 生成符合密码规则的随机密码
   * 【保底】每一类（letters/digits/specials）至少 1 个 → 保证校验通过
   * @param length 密码长度，默认 8；至少 3（保底需要）
   */
  static generatePassword(length: number = 8): string {
    const pwdChars: string[] = [];
    // 保底位
    pwdChars.push(this.getRandomChar(this.CHAR_POOL.letters));
    pwdChars.push(this.getRandomChar(this.CHAR_POOL.digits));
    pwdChars.push(this.getRandomChar(this.CHAR_POOL.specials));

    // 剩余字符全池随机填充
    const allChars =
      this.CHAR_POOL.letters + this.CHAR_POOL.digits + this.CHAR_POOL.specials;
    const remainCount = Math.max(length - 3, 0);
    for (let i = 0; i < remainCount; i++) {
      pwdChars.push(this.getRandomChar(allChars));
    }

    return this.shuffleArray(pwdChars).join("");
  }
  private static getRandomChar(str: string): string {
    const idx = Math.floor(Math.random() * str.length);
    return str[idx];
  }
  private static shuffleArray<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}
export { FooseTools };
