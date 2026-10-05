### sync-to-store.js 脚本内部机制（简要）

1. build ：直接调 SDK 自己`node_modules/.bin/` 里的`tsup` +`tsc` （不走`pnpm run build` ，绕开 lockfile 校验）
2. 定位消费者 ：祖先目录链 + 祖先的兄弟目录 → 遍历所有`node_modules/.pnpm` → 匹配`@fooseDB+sdk@` 前缀的安装目录
3. 同步 ：对每个安装目录，`fs.copyFileSync` 把`sdk/dist/**` 覆盖过去；Windows 下`.d.ts` 之类新文件如果之前不存在会自动新建子目录

### 以后每次 SDK 改完源码，只要

`cd sdk && pnpm sync`
client 里就能立刻看到新 SDK 行为（如果 client dev server 没跑`--force` ，记得 Ctrl+C 重开一次让 Vite 清缓存）。

以后你自己终端里的用法

# 日常开发 — SDK 改完一行命令搞定

cd sdk
pnpm sync

# 或者不分目录，直接全路径

node h:\pure-admin-fastify\sdk\scripts\sync-to-store.js

pnpm build # 1. 在 SDK 目录重新编译 → 新 dist/
pnpm sync # 2. 把 dist/ 里的文件同步到 pnpm-store 里对应的位置
