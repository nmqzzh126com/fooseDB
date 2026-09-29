import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false, // 用 tsc 单独生成 d.ts（保留 interface 前的 export 关键字）
  clean: true,
  target: "es2022",
  external: ["vue", "axios"],
  splitting: false,
  sourcemap: true,
});
