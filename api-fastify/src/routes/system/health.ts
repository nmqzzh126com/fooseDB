/**
 * 系统健康检查（替代旧 routes/root.ts 的 GET /）
 *   1. 同时注册 `GET /` 和 `GET /health`，双别名保证老客户端和新客户端都能查健康。
 *   2. 保持原有兼容字段：root:true + 原有 b 字段（让老客户端脚本判断健康时不受影响）
 *   3. 新增字段：datasources（注册表中每个数据源的连接状态摘要）
 */

import { type FastifyPluginAsync } from "fastify";
import { getAllStatuses } from "../../datasources/registry.js";
import { getAllCacheStatuses } from "../../caches/registry.js";

const ROOT_MAGIC_B = "a3a34433333334111aa33333333";

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  const handle = async () => {
    return {
      root: true,
      b: ROOT_MAGIC_B,
      uptime: process.uptime(),
      datasources: getAllStatuses(),
      caches: getAllCacheStatuses()
    };
  };
  fastify.get("/", handle);
  fastify.get("/health", handle);
};

export default plugin;
