/**
 * FoosDB 全局单例客户端
 * =======================================================================
 *
 * 设计原则：整个应用只创建 **一个** FooseClient 实例，所有业务模块共享。
 * 好处：
 *   1. 只登录一次（避免每个页面都 POST /api/auth/login）
 *   2. access_token / refresh_token / localStorage 状态全局一致
 *   3. token 过期自动 refresh 对所有页面透明
 *
 * 用三层架构：
 *   Layer 1：本文件   —— createFooseClient 懒加载单例
 *   Layer 2：*_api.ts —— 预绑定 object+table + 业务类型 + useFoose 工厂
 *   Layer 3：*.vue    —— 只管 useXxx() → data/loading/list/create/...
 *
 * 初始化时机：
 *   - 懒加载（推荐）：第一次 importFooseClient() 时才登录，页面首次打开自动触发
 *   - 提前初始化：main.ts 里 await ensureFooseClient()，App.vue 渲染前就绪
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
const DEFAULT_PASSWORD = "admin123!@#";

/**
 * 获取全局 FooseClient（懒加载，首次调用时自动登录）
 *
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
