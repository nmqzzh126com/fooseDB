/**
 * ReQrcode 组件 barrel 导出
 *
 * 遵循项目约定：子目录 + index.ts 模式（与 ReDialog / ReText / ReFlicker 一致）。
 * LoginQrCode.vue 通过 `import ReQrcode from "@/components/ReQrcode"` 导入时，
 * TypeScript 的 bundler moduleResolution 会自动命中本文件。
 */
import ReQrcode from "./src/index.vue";

export { ReQrcode };
export default ReQrcode;
