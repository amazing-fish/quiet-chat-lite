export function chatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Base URL 必须是安全的 HTTPS 地址。");
  }

  url.hash = "";
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalizedPath)) {
    url.pathname = normalizedPath;
  } else if (!normalizedPath) {
    url.pathname = "/v1/chat/completions";
  } else {
    url.pathname = `${normalizedPath}/chat/completions`.replace(/^\/+/, "/");
  }
  return url;
}
