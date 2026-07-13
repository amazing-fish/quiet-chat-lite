export function responseErrorMessage(status, fallback = "") {
  if (status === 400) return fallback || "请求设置无效，请检查后重试。";
  if (status === 401) return "鉴权失败，请检查 API Key。";
  if (status === 403) return "鉴权或模型权限不足，请检查 API Key 及聊天接口权限。";
  if (status === 408 || status === 504) return "上游模型响应超时，请稍后重试。";
  if (status === 422) return fallback || "该响应包含当前不支持的工具调用。";
  if (status === 429) return "请求过于频繁，请稍后重试。";
  if (status >= 500) return fallback || "模型服务返回了无法识别的响应。";
  return fallback || "请求失败，请稍后重试。";
}

export function requestErrorMessage(error, stoppedByUser) {
  if (stoppedByUser) return "已停止等待。";
  if (error instanceof DOMException && error.name === "AbortError") {
    return "请求超时，请稍后重试。";
  }
  if (error instanceof TypeError) {
    return "无法连接到模型服务。若 Base URL 可在浏览器打开，通常是该服务未允许跨域请求或拒绝了云端代理。";
  }
  return "请求失败，请稍后重试。";
}
