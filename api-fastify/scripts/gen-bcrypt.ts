/// <reference types="node" />
/**
 * 生成 bcrypt 哈希 —— 用于 .env ADMIN_PASSWORD 设置哈希值
 *
 * 用法：
 *   pnpm gen-bcrypt <password>              → cost 默认 10
 *   pnpm gen-bcrypt <password> <cost>       → 自定义 cost（4~31）
 *   pnpm gen-bcrypt admin123                → 推荐
 *
 * 输出示例：
 *   哈希: $2b$10$dNsXvuVZ7daYT/ejzI3kAutmQs5kB5J4ska9UHEVUGmDo9DfALakq
 *   验证: ✓ 正确
 *
 * 使用方法：将输出的哈希字符串（以 $2b$ 开头整行）复制到 .env：
 *   ADMIN_PASSWORD=$2b$10$dNsXvuVZ7daYT/ejzI3kAutmQs5kB5J4ska9UHEVUGmDo9DfALakq
 *
 * 后端认证时自动识别 $2 开头走 bcrypt.compare，否则走 timingSafeEqual 明文比较。
 */

import bcrypt from "bcryptjs";

const COST_MIN = 4;
const COST_MAX = 31;
const COST_DEFAULT = 10;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log("用法: pnpm gen-bcrypt <password> [cost]");
    console.log("  password  必填，要加密的明文密码");
    console.log("  cost      可选，bcrypt 强度 (4~31)，默认 10");
    console.log("");
    console.log("示例: pnpm gen-bcrypt admin123");
    process.exit(args.length === 0 ? 1 : 0);
  }

  const password = args[0];
  const cost = args[1] ? Number(args[1]) : COST_DEFAULT;

  if (!Number.isFinite(cost) || cost < COST_MIN || cost > COST_MAX) {
    console.error(`错误: cost 必须在 ${COST_MIN}~${COST_MAX} 之间，当前值: ${args[1]}`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, cost);
  const ok = await bcrypt.compare(password, hash);

  console.log("========================================");
  console.log("密码:     ", "*".repeat(password.length));
  console.log("Cost:     ", cost);
  console.log("哈希:     ", hash);
  console.log("验证:     ", ok ? "✓ 正确" : "✗ 失败");
  console.log("========================================");
  console.log("");
  console.log("复制以下行到 .env 即可:");
  console.log(`ADMIN_PASSWORD=${hash}`);
}

main().catch(e => {
  console.error("错误:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
