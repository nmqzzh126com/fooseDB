/**
 * 配置中心统一出口。
 *   - 环境变量 → getEnv()
 *   - 后台路径 → getAdminPath()
 *   - 缓存声明 → getCacheDecls() / getDefaultCacheName()
 *
 * 数据源不再由 .env 静态声明：每个项目（object 表一行）自带 db_type/db_url/db_path，
 * 启动时由 datasources/registry.ts 的 bulkRegisterObjectDsFromDb() 扫描注册。
 *
 * 注意：main.ts 顶部会先手写加载 FoosDB 的 .env（物理路径 api-fastify/.env），然后任何模块才能读到 process.env，
 *       所以 getAdminPath() 这里只需要同步读 process.env.ADMIN_PATH 即可（不引入循环依赖）。
 */

export { getEnv, type EnvConfig, type DataSourceDecl, type CacheDecl } from "./env.js";
export { getCacheDecls, getDefaultCacheName } from "./caches.js";

// —— 后台 SPA 入口路径（保持原有行为）——
const ADMIN_PATH_RE = /^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/;
const ADMIN_PATH_DEFAULT = "/admin";

export function getAdminPath(): string {
  const raw = (process.env.ADMIN_PATH ?? ADMIN_PATH_DEFAULT).trim();
  if (ADMIN_PATH_RE.test(raw)) return raw;
  console.warn(
    `[config] ADMIN_PATH=${JSON.stringify(raw)} 格式非法，已回退到默认 ${ADMIN_PATH_DEFAULT}。` +
      "合法示例：/admin  /portal  /sys/v1/manage"
  );
  return ADMIN_PATH_DEFAULT;
}
