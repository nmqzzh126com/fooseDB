/** 轻量日志封装（阶段 2 先不引入 pino 包，保持 0 新增依赖）。*/
type Level = "debug" | "info" | "warn" | "error";
let _minLevel: Level = "info";

export function setLogLevel(level: Level): void {
  _minLevel = level;
}

const ORDER: Level[] = ["debug", "info", "warn", "error"];
function shouldLog(l: Level): boolean {
  return ORDER.indexOf(l) >= ORDER.indexOf(_minLevel);
}

export const logger = {
  debug: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("debug")) return;
    console.debug(`[DEBUG][${tag}]`, ...args);
  },
  info: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("info")) return;
    console.info(`[INFO ][${tag}]`, ...args);
  },
  warn: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("warn")) return;
    console.warn(`[WARN ][${tag}]`, ...args);
  },
  error: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("error")) return;
    console.error(`[ERROR][${tag}]`, ...args);
  }
};
