/**
 * 测试环境变量设置 —— 必须在所有 src 模块之前导入。
 *
 * 策略：
 *   - 每个测试进程用独立临时 SQLite 文件（os.tmpdir() 下按 pid+rand 命名），
 *     与仓库内 data/app.db 物理隔离，测试不会污染正式库。
 *     node:test 每个测试文件独立子进程 + --test-concurrency=1 串行 →
 *     按 pid+rand 命名即每文件一个全新库、互不干扰。
 *   - 禁用 Redis（Stub 模式）
 *   - 设置 JWT_SECRET、ADMIN_PATH
 *   - 退出时 best-effort 删除 .db / .db-wal / .db-shm（Windows 下 WAL/SHM
 *     可能因 SQLite 连接未完全释放而删除失败，静默忽略即可；tmpdir 本身
 *     也有系统级定期清理策略）
 */

import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import fs from "node:fs";

// —— 生成临时 app.db 路径 ——
// 用 pid + 随机后缀，确保每个测试文件独立。
const randSuffix = randomBytes(4).toString("hex"); // 8 位
const tmpDbPath = resolve(tmpdir(), `foosdb-test-${process.pid}-${randSuffix}.db`);
process.env.APP_DB_PATH_FOR_TESTS = tmpDbPath;

// JWT 签名密钥（测试专用）
process.env.JWT_SECRET ??= "test-secret-for-unit-tests-2026";

// 管理端面板账号（测试专用）—— 与测试 helper 的 adminAccessToken("admin","admin123") 对齐
process.env.ADMIN_USERNAME ??= "admin";
process.env.ADMIN_PASSWORD ??= "admin123";

// 后台入口路径
process.env.ADMIN_PATH ??= "/admin";

// —— 禁用 Redis（避免测试依赖外部 Redis 服务）——
process.env.REDIS_CACHE_DEFAULT__ENABLED = "false";

// —— 进程退出时清理临时文件（best-effort）——
// 注意：process.on("exit") 只能执行同步代码，所以直接 unlinkSync 即可。
// SQLite 连接在进程退出时操作系统会自动关闭；closeDb() 已在测试 helper 的
// teardown 里被调用，正常情况下 WAL/SHM 会被 checkpoint 清空。
function cleanupTmpDb(): void {
  const tryRm = (p: string) => {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* Windows 下 WAL/SHM 可能被 SQLite 残余句柄占用，静默忽略 */
    }
  };
  tryRm(tmpDbPath);
  tryRm(tmpDbPath + "-wal");
  tryRm(tmpDbPath + "-shm");
  // 如果父目录因 mkdirSync 创建过（我们没创建父目录所以不会有这种情况）
  // 这里不清理父目录，tmpdir 是系统管理的
}
process.on("exit", cleanupTmpDb);

// 额外注册 SIGINT/SIGTERM 处理，让强制退出也能清理（exit 事件会在
// process.exit() 和异常退出时都触发，SIGINT/SIGTERM 不触发 exit，
// 所以单独处理）
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanupTmpDb();
    process.exit(0);
  });
}
