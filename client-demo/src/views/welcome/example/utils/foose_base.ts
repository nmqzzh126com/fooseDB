import { createFooseClient, type FooseClient } from "@/api/foose_db";

/* —— 单例 + Promise（防并发重复初始化） —— */
let instance: FooseClient | null = null;
let initPromise: Promise<FooseClient> | null = null;

/** 登录账号来源：环境变量 → 默认值（开发用） */
export const DEFAULT_OBJECT_NAME = "sqlite_demo"; //接口名称
const FOOSE_DB_BASE_URL =
  import.meta.env.VITE_FOOSE_DB_BASE_URL || "http://127.0.0.1:8858"; //接口地址
//如果接口没有登录认证要求,则可以不配置用户名和密码
const DEFAULT_USERNAME = "demo"; //接口用户名
const DEFAULT_PASSWORD = "admin123456!@#"; //接口密码

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
