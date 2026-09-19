/**
 * PM2 进程管理配置 —— 同时覆盖 dev 和 prod 两种场景。
 *
 * 用法：
 *   pm2 start ecosystem.config.cjs --only foosdb-dev      # 开发（tsx watch，文件改动自动重启）
 *   pm2 start ecosystem.config.cjs --only foosdb          # 生产（node dist/main.js）
 *   pm2 logs foosdb-dev                                   # 看日志
 *   pm2 stop foosdb-dev                                   # 停止
 *   pm2 delete foosdb-dev                                 # 从 PM2 注册表移除
 *   pm2 save                                              # 保存当前进程列表 → 下次 pm2 resurrect 自动恢复
 *
 *   Windows 开机自启：pm2-startup install → pm2 save
 *   Linux 开机自启：pm2 startup systemd -u <user> → pm2 save
 *
 * 与 /api/system/restart 端点的配合：
 *   重启端点内部做 process.exit(0)，PM2 监控到进程退出会自动拉起新实例。
 *   注意：dev 模式用 tsx watch 本身就能监听 .ts 文件改动，**但 .env 改动不会触发**——
 *   这时调 /api/system/restart 就派上用场（tsx watch 被 PM2 拉起时会重新读 .env）。
 *
 * 文档：https://pm2.keymetrics.io/docs/usage/application-declaration/
 */

module.exports = {
  apps: [
    {
      name: "foosdb",
      /** 构建产物入口（生产部署用 `pnpm build` 先生成 dist/） */
      script: "dist/main.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      /** 崩溃/退出后等 3 秒再拉起（避免雪崩） */
      restart_delay: 3000,
      /** 10 秒内连续退出超过 5 次，PM2 判定进程坏了，停止重启（需要 pm2 restart 手动复位） */
      max_restarts: 5,
      min_uptime: "10s",
      /** .env 生效（pm2 会自动加载同目录 .env，这里保持默认即可） */
      env: {
        NODE_ENV: "production"
      },
      /** 日志目录 —— 默认 $HOME/.pm2/logs，这里显式指定到项目内方便排查 */
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true
    },

    {
      name: "foosdb-dev",
      /** 开发模式直接用 tsx watch —— 文件改动自动重启 */
      script: "node_modules/.bin/tsx",
      args: "watch src/main.ts",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      restart_delay: 1000,
      max_restarts: 10,
      min_uptime: "3s",
      env: {
        NODE_ENV: "development"
      },
      out_file: "./logs/pm2-dev-out.log",
      error_file: "./logs/pm2-dev-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true
    }
  ]
};
