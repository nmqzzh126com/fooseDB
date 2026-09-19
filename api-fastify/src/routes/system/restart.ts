/**
 * 系统重启：POST /api/system/restart
 *
 *   让当前进程在发完 202 响应后，执行优雅停机 + process.exit(0)。
 *   真正的「重启」依赖外部守护进程（PM2 / systemd / Windows 服务等）——
 *   守护进程监控到进程退出后会自动拉起新实例，新实例重新读 .env。
 *   若没有守护进程，调此端点的效果就是「把服务停了」。
 *
 *   使用场景：
 *     · 前端 admin 面板改了 .env 里的运行参数（TOKEN_TTL / BCRYPT_COST /
 *       PAGE_SIZE / HOST 等模块级常量），不想 ssh 进服务器；
 *     · 纯运维：进程状态有异常需要拉新实例复位。
 *
 *   安全：
 *     · 仅 system admin（JWT.object_id === -1）可调用，其他 401/403；
 *     · 进程内一次性防重 —— 30 秒内只能调一次（避免前端误连/攻击者循环触发）；
 *     · 显式 .env 开关：ALLOW_SYSTEM_RESTART=true 才启用，默认关闭（防止「忘了上
 *       守护进程就开放了一个自毁端点」这种运维误操作）。
 *       做成函数而非模块级常量，每次请求动态读 env —— 避免 ESM 模块缓存让
 *       运行时 .env 变更无法生效。
 */

import { type FastifyPluginAsync } from "fastify";
import { BusinessError } from "../../utils/errors.js";
import { requireAdminPanel } from "../../services/config.service.js";

/** 一次性防重窗口（毫秒）。进过一次端点后此窗口内直接拒绝。 */
const RESTART_COOLDOWN_MS = 30_000;

/** 每次请求时判定 .env 开关，而非模块级常量。 */
function isRestartEnabled(): boolean {
  return (process.env.ALLOW_SYSTEM_RESTART ?? "").trim().toLowerCase() === "true";
}

let _lastRestartAt = 0;

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post("/api/system/restart", async function (request, reply) {
    // —— 开关先判定：没开 → 404（隐藏存在，防枚举）
    if (!isRestartEnabled()) {
      throw new BusinessError(404, "endpoint not found | 端点不存在");
    }

    // —— admin 鉴权（token + 客户端指纹）
    const fp = request.authContext.fingerprint;
    const token = request.authContext.bearerToken;
    requireAdminPanel({ token, fingerprint: fp });

    // —— 一次性防重：同进程内 30 秒内只允许一次
    const now = Date.now();
    if (now - _lastRestartAt < RESTART_COOLDOWN_MS) {
      const remaining = Math.ceil((RESTART_COOLDOWN_MS - (now - _lastRestartAt)) / 1000);
      return reply.code(429).send({
        error: "RESTART_COOLDOWN | 重启冷却中",
        message: `重启冷却中，请 ${remaining} 秒后再试。`
      });
    }
    _lastRestartAt = now;

    // —— 先把 202 响应发出去，再安排退出
    reply.status(202).send({
      ok: true,
      message: "进程即将在约 1 秒后优雅退出；外部守护进程（PM2 / systemd 等）应自动拉起新实例。",
      cooldownSec: RESTART_COOLDOWN_MS / 1000
    });

    // —— 给 1 秒让 HTTP 响应完整写出，再执行优雅停机 + exit
    setTimeout(async () => {
      try {
        await fastify.close();
      } catch {
        /* fastify.close 抛错也继续退出，不能被异常卡住 */
      }
      process.exit(0);
    }, 1000);
  });
};

export default plugin;
