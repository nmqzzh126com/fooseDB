// FoosDB 后端 Prettier 配置
// 和 admin-vue/.prettierrc.js 保持一致的风格，整个 monorepo 用同一套格式
/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: false,
  trailingComma: "none",
  arrowParens: "avoid",
  tabWidth: 2,
  printWidth: 100,
  endOfLine: "lf",
  bracketSpacing: true
};
