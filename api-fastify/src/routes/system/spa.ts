/**
 * 后台 SPA 入口（替代旧 routes/pure_admin.ts）
 *
 * 完全保持原有三条路由的行为（URL 100% 不变）：
 *   - base         → 302 base/
 *   - base/        → sendFile index.html
 *   - base/*       → 有扩展名：剥前缀后 sendFile(rest)；无扩展名 fallback 到 index.html
 *
 * 前缀来源：getAdminPath()（从 process.env.ADMIN_PATH，main.ts 已先加载 .env 到 process.env）。
 */

import { type FastifyPluginAsync } from "fastify";
import { getAdminPath } from "../../config/index.js";

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  const base = getAdminPath();

  fastify.get(base, async function (_req, reply) {
    reply.redirect(base + "/");
  });

  fastify.get(base + "/", async function (_req, reply) {
    return reply.sendFile("index.html");
  });

  fastify.get(base + "/*", async function (req, reply) {
    const url = req.url.split("?")[0];
    const rest = url.startsWith(base + "/") ? url.slice((base + "/").length) : "";
    const hasExt = /\.[a-zA-Z0-9]+$/.test(rest);
    if (hasExt) {
      try {
        return await reply.sendFile(rest);
      } catch (err) {
        return reply.code(404).send({ error: "Not Found | 未找到" });
      }
    }
    return reply.sendFile("index.html");
  });
};

export default plugin;
