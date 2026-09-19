import { getPluginsList } from "./build/plugins.ts";
import { include, exclude } from "./build/optimize.ts";
import { type UserConfigExport, type ConfigEnv, loadEnv } from "vite";
import fs from "node:fs";
import {
  root,
  alias,
  wrapperEnv,
  pathResolve,
  __APP_INFO__
} from "./build/utils.ts";

/**
 * 开发模式 Vite dev server 的 proxy 规则中：
 *   后台入口前缀（默认 /admin）必须同步转发到 Fastify 后端，
 *   否则通过 Vite 端口访问自定义后台路径会触发 Vite 自己的 404。
 * 我们**直接从 api-fastify/.env 读取 ADMIN_PATH**（物理目录名保留 api-fastify），
 *   避免用户「前后端改两次配置 → 不同步」的维护负担。
 */
const ADMIN_PATH_RE = /^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/;
function readAdminPathFromBackend(): string {
  const defaultPath = "/admin";
  try {
    const f = pathResolve("../api-fastify/.env", import.meta.url);
    if (!fs.existsSync(f)) return defaultPath;
    const raw = fs.readFileSync(f, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (k === "ADMIN_PATH" && ADMIN_PATH_RE.test(v)) return v;
    }
  } catch {
    /* 读取失败就回退默认值，不阻塞 dev server 启动 */
  }
  return defaultPath;
}
const ADMIN_PATH = readAdminPathFromBackend();

export default async ({ mode }: ConfigEnv): Promise<UserConfigExport> => {
  const { VITE_CDN, VITE_PORT, VITE_COMPRESSION, VITE_PUBLIC_PATH } =
    wrapperEnv(loadEnv(mode, root));
  return {
    base: VITE_PUBLIC_PATH,
    root,
    resolve: {
      alias
    },
    // 服务端渲染
    server: {
      // 端口号
      port: VITE_PORT,
      host: "0.0.0.0",
      // 本地跨域代理 https://cn.vitejs.dev/config/server-options.html#server-proxy
      // /api 与 /uploads 等转发到后端 Fastify（8858），dev 模式下无跨域
      // 另外额外转发自定义后台入口 ADMIN_PATH，开发态 Vite 端口访问后台页也能一致命中
      proxy: {
        "/api": {
          target: "http://localhost:8858",
          changeOrigin: true
        },
        "/uploads": {
          target: "http://localhost:8858",
          changeOrigin: true
        },
        [ADMIN_PATH]: {
          target: "http://localhost:8858",
          changeOrigin: true
        }
      },
      // 预热文件以提前转换和缓存结果，降低启动期间的初始页面加载时长并防止转换瀑布
      warmup: {
        clientFiles: ["./index.html", "./src/{views,components}/*"]
      }
    },
    plugins: await getPluginsList(VITE_CDN, VITE_COMPRESSION),
    // https://cn.vitejs.dev/config/dep-optimization-options.html#dep-optimization-options
    optimizeDeps: {
      include,
      exclude
    },
    build: {
      // https://cn.vitejs.dev/guide/build.html#browser-compatibility
      target: "es2015",
      sourcemap: false,
      // 消除打包大小超过500kb警告
      chunkSizeWarningLimit: 4000,
      rolldownOptions: {
        input: {
          index: pathResolve("./index.html", import.meta.url)
        },
        // 静态资源分类打包
        output: {
          chunkFileNames: "static/js/[name]-[hash].js",
          entryFileNames: "static/js/[name]-[hash].js",
          assetFileNames: "static/[ext]/[name]-[hash].[ext]"
        },
        checks: {
          pluginTimings: false,
          toleratedTransform: false
        }
      }
    },
    define: {
      __INTLIFY_PROD_DEVTOOLS__: false,
      __APP_INFO__: JSON.stringify(__APP_INFO__)
    }
  };
};
