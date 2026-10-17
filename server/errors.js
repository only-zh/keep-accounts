/** 带 HTTP 状态码的业务异常（路由层统一转成 JSON 错误） */
export class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
