/**
 * 把「admin-vue/dist」拷贝进「api-fastify/dist/public」
 * 这样 FoosDB（物理目录 api-fastify）构建产物自包含前端，部署时不再依赖 admin-vue 目录
 *
 * 用法（api-fastify 目录下执行）：
 *   pnpm build:frontend   ← 先构建 admin-vue（产出 admin-vue/dist）
 *   pnpm build            ← tsc 编译 + 自动执行本脚本（见 package.json scripts.build 末尾 && node ...）
 *   或直接 pnpm build:all ← 一步做完上面两步
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 路径基准：本脚本位于 api-fastify/scripts/
const rootDir = path.resolve(__dirname, "..");                // api-fastify/
const src = path.resolve(rootDir, "..", "admin-vue", "dist"); // monorepo 兄弟 admin-vue/dist
const dest = path.resolve(rootDir, "dist", "public");         // 嵌入目标：api-fastify/dist/public

if (!fs.existsSync(src)) {
  // 允许「只打后端不带前端」的场景，只 warn 不报错
  console.warn(
    "\n[copy-frontend-dist] ⚠️  找不到 admin-vue 构建产物，前端不会被嵌入：\n" +
    `        src = ${src}\n` +
    `        如果需要前后端一体包，请先运行 pnpm build:frontend 再 pnpm build（或直接 pnpm build:all）。\n` +
    `        本次仅完成后端编译。\n`
  );
  process.exit(0);
}

// 每次都干净重建 dest，避免老文件残留
if (fs.existsSync(dest)) {
  fs.rmSync(dest, { recursive: true, force: true });
}
fs.mkdirSync(dest, { recursive: true });

fs.cpSync(src, dest, { recursive: true, force: true });

// 简单统计拷贝后的文件数量
function countFiles(dir) {
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += countFiles(path.join(dir, ent.name));
    else n++;
  }
  return n;
}

const n = countFiles(dest);
console.log(
  `\n[copy-frontend-dist] ✅ 前端构建产物已嵌入 api-fastify 包内：\n` +
  `        源：${src}\n` +
  `        目：${dest}\n` +
  `        文件数：${n}\n`
);
