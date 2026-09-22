/**
 * FoosDB 业务层桥接 —— 全局单例客户端管理
 * =======================================================================
 *
 * ⚠️ 本文件**不属于** SDK（@foosdb/sdk），是业务层胶水代码：
 *   SDK 只提供 createFooseClient / createUseFoose 等无状态工具，
 *   业务层需要自己决定：客户端初始化时机？账号密码从哪来？单例还是多实例？
 *   本文件就是这些决策的落地点，最终产物是一个 `importFooseClient()` getter，
 *   被 *_api.ts 通过 createUseFoose(config, importFooseClient) 注入。
 *
 * 三层架构（业务视角）：
 * ────────────────────────────────────────────────────────────────────────
 *
 *   SDK (@foosdb/sdk / foose_db.ts)
 *   │  createFooseClient          ← 初始化 + 登录 + axios 实例
 *   │  FooseClient.foose*         ← 低级 CRUD HTTP 方法
 *   │  useFoose                   ← Vue 组合式（需外部持有实例）
 *   │  createUseFoose             ← 表级工厂（getFoose 由业务注入）
 *   │
 *   ▼ 业务层桥接（本文件）
 *   │  importFooseClient()         ← 懒加载单例，防并发重复初始化
 *   │  ensureFooseClient()         ← main.ts 提前初始化用
 *   │  resetFooseClient()          ← 登出/切换账号
 *   │
 *   ▼ 表级定义（product_api.ts / product_type_api.ts / ...）
 *   │  export const useProduct = createUseFoose<ProductRow>(
 *   │    { object: "sqlite_demo", table: "foose_product" },
 *   │    importFooseClient   ← 注入本文件的 getter
 *   │  );
 *   │
 *   ▼ 组件消费（test_api/index.vue / edit.vue / ...）
 *      const { listResult, loading, errorInfo, getPageList, create, remove } = useProduct();
 *
 * 初始化时机（两种都支持）：
 *   ① 懒加载（推荐）：首次 importFooseClient() 时才登录，页面首次打开自动触发
 *   ② 提前初始化：main.ts 里 await ensureFooseClient()，App.vue 渲染前就绪
 *
 * 账号配置：见文件内 DEFAULT_USERNAME / DEFAULT_PASSWORD / FOOSE_DB_BASE_URL
 *   - FOOSE_DB_BASE_URL 可通过 VITE_FOOSE_DB_BASE_URL 环境变量覆盖
 *   - 用户名密码硬编码是 demo 项目的简化写法，生产项目应从登录表单 / 路由守卫获取
 */
import { createFooseClient, type FooseClient } from "@/api/foose_db";

/* —— 单例 + Promise（防并发重复初始化） —— */
let instance: FooseClient | null = null;
let initPromise: Promise<FooseClient> | null = null;

/** 登录账号来源：环境变量 → 默认值（开发用） */
export const DEFAULT_OBJECT_NAME = "sqlite_demo";
const FOOSE_DB_BASE_URL =
  import.meta.env.VITE_FOOSE_DB_BASE_URL || "http://127.0.0.1:8858";
const DEFAULT_USERNAME = "demo";
const DEFAULT_PASSWORD = "admin123456!@#";

/**
 * 获取全局 FooseClient（懒加载，首次调用时自动登录）
 *   import { importFooseClient } from "@/api/demo/foose_base";
 *   const foose = await importFooseClient();
 */
export async function importFooseClient(): Promise<FooseClient> {
  if (instance) return instance;
  if (initPromise) return initPromise; // 并发中，等第一次

  initPromise = createFooseClient({
    baseURL: FOOSE_DB_BASE_URL,
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD
  })
    .then(client => {
      instance = client;
      initPromise = null;
      return client;
    })
    .catch(err => {
      initPromise = null;
      throw err;
    });

  return initPromise;
}

/**
 * 提前初始化（main.ts 里用，可选）
 *   await ensureFooseClient(); // 失败会 throw，建议 catch 一下
 */
export function ensureFooseClient() {
  return importFooseClient();
}

/**
 * 重置单例（登出/切换账号时用）
 */
export function resetFooseClient() {
  instance?.fooseLogout?.().catch(() => {
    console.log("foose logout failed");
  });
  instance = null;
  initPromise = null;
}

/**
 * 同步获取（可能是 null，首次加载时返回 null）
 * 仅用于不关心初始化时机的场景（如菜单渲染时读 user 信息）
 */
export function peekFooseClient(): FooseClient | null {
  return instance;
}
