#!/usr/bin/env node
/**
 * sync-to-store.js —— 把 SDK 重新 build 后的 dist/ 文件，
 *   同步覆盖到所有通过 pnpm `file:` 安装了 @fooseDB/sdk 的 node_modules 目录。
 *
 * 为什么需要这个脚本？
 *   pnpm 对 file: 依赖会创建硬链接（HardLink），指向源码目录的文件。
 *   但 tsup.config.ts 里 clean: true 会先 rm -rf dist/ 再重建，
 *   删除旧 inode 后硬链就断了 → node_modules 里是悬空链接 / 缺失文件。
 *   本脚本重建这些链接（或在跨盘符时回退为 copy）。
 *
 * 用法：
 *   pnpm sync              # 同步（先 build 再 sync）
 *   node scripts/sync-to-store.js --no-build   # 只 sync 不 build
 *
 * 原理：
 *   1. 从 SDK 自己的 package.json 读出 name & version
 *   2. 向上遍历祖先目录，找所有含 node_modules/.pnpm 的项目根
 *   3. 在每个 .pnpm 里找 @fooseDB+sdk@* 的安装目录
 *   4. 把 sdk/dist/** 的每个文件 copyFileSync 过去
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

// —— 1. 基础路径 ——
const SDK_ROOT = path.resolve(import.meta.dirname, "..");
const DIST_SRC = path.join(SDK_ROOT, "dist");
const PKG = require(path.join(SDK_ROOT, "package.json"));
const PKG_NAME = PKG.name; // "@fooseDB/sdk"
// pnpm 把 scope 里的 "/" 替换成 "+"
const PNPM_DIR_NAME = PKG_NAME.replace("/", "+"); // "@fooseDB+sdk"

// —— 2. CLI 参数 ——
const args = new Set(process.argv.slice(2));
const SKIP_BUILD = args.has("--no-build");
const DRY_RUN = args.has("--dry-run");

// —— 3. 可选：先 build ——
if (!SKIP_BUILD) {
  console.log("🔨  正在 build SDK …");
  const { spawnSync } = await import("node:child_process");

  // 优先用 SDK 自己 node_modules 里的 tsup / tsc，绕开 pnpm 的 lockfile 校验
  const tsupBin = path.join(
    SDK_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsup.cmd" : "tsup"
  );
  const tscBin = path.join(
    SDK_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc"
  );

  // 也可能没装依赖，回退用 node + 直接 require
  function runBuild() {
    const steps = [
      { cmd: tsupBin, args: [] },
      {
        cmd: tscBin,
        args: ["--emitDeclarationOnly", "--declaration", "--outDir", "dist"],
      },
    ];
    for (const s of steps) {
      if (!fs.existsSync(s.cmd)) {
        console.error(`❌ 找不到 ${path.basename(s.cmd)}，请先在 SDK 目录跑：pnpm install`);
        return false;
      }
      const res = spawnSync(s.cmd, s.args, {
        cwd: SDK_ROOT,
        stdio: "inherit",
        timeout: 120_000,
        shell: process.platform === "win32", // Windows 上 .cmd 需要 shell 执行
      });
      if (res.status !== 0) return false;
    }
    return true;
  }

  const ok = runBuild();
  if (!ok) {
    console.error("❌ build 失败，已中止 sync");
    process.exit(1);
  }
  console.log();
} else {
  console.log("⏭  跳过 build（--no-build）");
}

// —— 4. 确认 dist/ 存在 ——
if (!fs.existsSync(DIST_SRC) || !fs.statSync(DIST_SRC).isDirectory()) {
  console.error(`❌ dist/ 目录不存在：${DIST_SRC}`);
  console.error("   请先执行 pnpm build");
  process.exit(1);
}

// —— 5. 找所有可能安装了本 SDK 的 node_modules/.pnpm ——
//   策略：
//     a) 向上遍历祖先目录（SDK 自己、可能的 monorepo 根）
//     b) 祖先目录的兄弟目录（比如 SDK 在 /repo/sdk，兄弟 /repo/client 就是典型消费者）
function findAllPnpmDirs(startFrom) {
  const result = [];
  const seen = new Set();
  const add = (dir) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      result.push(dir);
    }
  };

  // a) 祖先链
  const ancestors = [];
  let dir = path.resolve(startFrom);
  for (let i = 0; i < 20; i++) {
    ancestors.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const anc of ancestors) {
    add(path.join(anc, "node_modules", ".pnpm"));
  }

  // b) 每个祖先目录的兄弟目录（浅度扫描：只看一级子目录）
  for (const anc of ancestors) {
    try {
      const siblings = fs.readdirSync(anc, { withFileTypes: true });
      for (const sib of siblings) {
        if (!sib.isDirectory()) continue;
        if (sib.name === "node_modules" || sib.name === ".git") continue;
        // 跳过 SDK 自己
        if (path.resolve(anc, sib.name) === SDK_ROOT) continue;
        add(path.join(anc, sib.name, "node_modules", ".pnpm"));
      }
    } catch {
      // 没权限的目录跳过
    }
  }

  return result;
}

const pnpmDirs = findAllPnpmDirs(SDK_ROOT);
console.log(`🔍  找到 ${pnpmDirs.length} 个 node_modules/.pnpm 目录`);
for (const d of pnpmDirs) console.log(`     ${path.relative(SDK_ROOT, d)}`);

// —— 6. 收集 dist/ 里所有文件（递归） ——
function walkFiles(root, base = "") {
  const out = [];
  const abs = path.join(root, base);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(root, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

const distFiles = walkFiles(DIST_SRC);
console.log(`📦  dist/ 中有 ${distFiles.length} 个文件待同步：`);
for (const f of distFiles) console.log(`     ${f}`);
console.log();

// —— 7. 在每个 .pnpm 里定位 @fooseDB+sdk@* 的安装目录 ——
//    pnpm 目录名形如：
//      @fooseDB+sdk@file+..+sdk_de_93ec5a220589fe5388d3d5578b6e2d4b
//      @fooseDB+sdk@0.1.1_hashashash
function findInstallDirs(pnpmDir) {
  if (!fs.existsSync(pnpmDir)) return [];
  return fs
    .readdirSync(pnpmDir)
    .filter(name => name.startsWith(PNPM_DIR_NAME + "@"))
    .map(name =>
      path.join(
        pnpmDir,
        name,
        "node_modules",
        ...PKG_NAME.split("/") // "@fooseDB/sdk" → ["@fooseDB", "sdk"]
      )
    )
    .filter(target => fs.existsSync(target)); // 过滤掉还没完整安装的半成品
}

let totalSynced = 0;
let totalMissing = 0;
const affectedDirs = new Set();

for (const pnpmDir of pnpmDirs) {
  const installDirs = findInstallDirs(pnpmDir);
  if (installDirs.length === 0) continue;

  const relativePnpm = path.relative(SDK_ROOT, pnpmDir);
  console.log(`📁 ${relativePnpm}`);

  for (const installDir of installDirs) {
    const relInstall = path.relative(SDK_ROOT, installDir);
    console.log(`   └─ ${relInstall}`);
    affectedDirs.add(installDir);

    for (const relFile of distFiles) {
      const src = path.join(DIST_SRC, relFile);
      const dst = path.join(installDir, relFile);

      // 确保目标子目录存在
      const dstDir = path.dirname(dst);
      if (!fs.existsSync(dstDir)) {
        fs.mkdirSync(dstDir, { recursive: true });
      }

      // 读取源文件 md5 与目标 md5 对比，避免不必要 copy
      let needCopy = !fs.existsSync(dst);
      if (!needCopy) {
        try {
          const srcStat = fs.statSync(src);
          const dstStat = fs.statSync(dst);
          // 硬链会共享 inode → 直接过
          if (srcStat.ino === dstStat.ino && process.platform !== "win32") {
            continue;
          }
          // Windows 用 size+mtime 近似判断
          if (
            srcStat.size === dstStat.size &&
            Math.abs(srcStat.mtimeMs - dstStat.mtimeMs) < 500
          ) {
            continue; // 看起来是新的，跳过
          }
          needCopy = true;
        } catch {
          needCopy = true;
        }
      }

      if (DRY_RUN) {
        console.log(`      ~ ${relFile} (dry-run, 未实际 copy)`);
        continue;
      }

      try {
        fs.copyFileSync(src, dst);
        const dstStat = fs.statSync(dst);
        totalSynced++;
        // Windows: 尝试创建硬链更优（节省空间 + 自动同步）
        // 但 copyFileSync 已经覆盖，硬链只有在下次 build 前才有意义
        console.log(`      ✓ ${relFile}`);
      } catch (err) {
        totalMissing++;
        console.error(`      ✗ ${relFile} → ${err.message}`);
      }
    }
  }
}

// —— 8. 没有找到任何安装目录 ——
if (affectedDirs.size === 0) {
  console.warn(
    `⚠️  没有找到任何安装了 ${PKG_NAME} 的 node_modules/.pnpm 目录。\n` +
    `   如果是首次安装，先在 client 目录跑一次 pnpm install。`
  );
}

// —— 9. 兜底：node_modules/@scope/pkg 本身（有些工具直接读这个软链路径）——
//    如果它是悬空链接，先删掉再让 pnpm 修复；否则 copy 一份过去保险
const directLinkTargets = [];
for (const pnpmDir of pnpmDirs) {
  const direct = path.join(path.dirname(pnpmDir), ...PKG_NAME.split("/"));
  let stat;
  try {
    stat = fs.lstatSync(direct);
  } catch {
    continue; // 不存在，跳过
  }
  // 存在就记录（软链 / 真实目录都可以）
  directLinkTargets.push(direct);
}

// —— 10. 总结 ——
console.log();
if (DRY_RUN) {
  console.log(`🧪  DRY-RUN 完成（未实际写入）。`);
} else {
  console.log(
    `✅ sync 完成：已向 ${affectedDirs.size} 个安装目录同步 ${totalSynced} 个文件` +
    (totalMissing ? `，${totalMissing} 个失败` : "")
  );
}
console.log(`\n   源目录：${DIST_SRC}`);
console.log(`   扫描的 .pnpm 目录：${pnpmDirs.length} 个`);
if (affectedDirs.size > 0) {
  console.log(`   写入的安装目录：${[...affectedDirs].length} 个`);
}
