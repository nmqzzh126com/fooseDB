/** 通用业务错误：路由层可根据此错误快速转成 4xx/5xx。 */
export class BusinessError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;
  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = "BusinessError";
  }
}
