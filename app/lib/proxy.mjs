import { promises as dns } from "node:dns";

import { chatCompletionsUrl } from "./chat-endpoint.mjs";

const MAX_MESSAGES = 100;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_BODY_LENGTH = 1_000_000;
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const PUBLIC_DNS_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
];
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
];

class ProxyError extends Error {
  constructor(status, code, message, upstreamResponse = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstreamResponse = upstreamResponse;
  }
}

function jsonError(status, code, message, upstreamResponse = null) {
  return Response.json(
    {
      error: { code, message },
      ...(upstreamResponse ? { upstreamResponse } : {}),
    },
    { status },
  );
}

function visibleResponseHeaders(headers) {
  const visible = {};
  headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (normalized !== "set-cookie" && normalized !== "set-cookie2") {
      visible[name] = value;
    }
  });
  return visible;
}

async function captureUpstreamResponse(response) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: visibleResponseHeaders(response.headers),
    body: await response.text(),
  };
}

function parseResponseJson(upstreamResponse) {
  try {
    return JSON.parse(upstreamResponse.body);
  } catch {
    return null;
  }
}

function ipv4Parts(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number(part));
  if (
    numbers.some(
      (part, index) =>
        !/^\d+$/.test(parts[index]) || part < 0 || part > 255,
    )
  ) {
    return null;
  }
  return numbers;
}

function isPublicIpv4(address) {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c <= 2) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) {
    return false;
  }
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isProxySyntheticIpv4(address) {
  const parts = ipv4Parts(address);
  return (
    parts !== null &&
    parts[0] === 198 &&
    (parts[1] === 18 || parts[1] === 19)
  );
}

function ipv6Parts(address) {
  if (typeof address !== "string") return null;
  let normalized = address.toLowerCase().split("%")[0];

  if (normalized.includes(".")) {
    const tailIndex = normalized.lastIndexOf(":");
    const mappedParts = ipv4Parts(normalized.slice(tailIndex + 1));
    if (tailIndex < 0 || !mappedParts) return null;
    const high = ((mappedParts[0] << 8) | mappedParts[1]).toString(16);
    const low = ((mappedParts[2] << 8) | mappedParts[3]).toString(16);
    normalized = `${normalized.slice(0, tailIndex)}:${high}:${low}`;
  }

  const sections = normalized.split("::");
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections.length === 2 && sections[1]
    ? sections[1].split(":")
    : [];
  const explicit = [...left, ...right];
  if (explicit.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  if (sections.length === 1) {
    return explicit.length === 8
      ? explicit.map((part) => Number.parseInt(part, 16))
      : null;
  }

  const missing = 8 - explicit.length;
  if (missing < 1) return null;
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array(missing).fill(0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function isPublicIpv6(address) {
  const parts = ipv6Parts(address);
  if (!parts) return false;

  const mappedIpv4 =
    parts.slice(0, 5).every((part) => part === 0) &&
    parts[5] === 0xffff;
  if (mappedIpv4) {
    return isPublicIpv4(
      `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`,
    );
  }

  // The deprecated IPv4-compatible ::/96 range is reserved, even when its
  // low 32 bits resemble a public IPv4 address.
  if (parts.slice(0, 6).every((part) => part === 0)) return false;
  if ((parts[0] & 0xfe00) === 0xfc00) return false;
  if ((parts[0] & 0xffc0) === 0xfe80) return false;
  if ((parts[0] & 0xff00) === 0xff00) return false;
  if (parts[0] === 0x2001 && parts[1] === 0x0db8) return false;
  return true;
}

export function isPublicIp(address) {
  return address.includes(":")
    ? isPublicIpv6(address)
    : isPublicIpv4(address);
}

function isIpLiteral(hostname) {
  return ipv4Parts(hostname) !== null || hostname.includes(":");
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function runAbortable(operation, signal) {
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const stopOnAbort = () => {
      signal.removeEventListener("abort", stopOnAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", stopOnAbort, { once: true });

    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw abortReason(signal);
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", stopOnAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", stopOnAbort);
          reject(error);
        },
      );
  });
}

function createAbortScope(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const stopOnParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    stopOnParentAbort();
  } else {
    parentSignal.addEventListener("abort", stopOnParentAbort, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Timed out", "AbortError")),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", stopOnParentAbort);
    },
  };
}

export async function validateBaseUrl(
  baseUrl,
  resolveHostname,
  { signal } = {},
) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProxyError(400, "invalid_target", "Base URL 格式无效。");
  }

  if (url.protocol !== "https:") {
    throw new ProxyError(400, "unsafe_target", "Base URL 必须使用 HTTPS。");
  }
  if (url.username || url.password) {
    throw new ProxyError(400, "unsafe_target", "Base URL 不能包含用户名或密码。");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new ProxyError(400, "unsafe_target", "Base URL 必须指向公网服务。");
  }

  if (isIpLiteral(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new ProxyError(400, "unsafe_target", "Base URL 不能指向本地或内网地址。");
    }
  } else {
    let addresses;
    try {
      addresses = await resolveHostname(hostname, { signal });
    } catch {
      throw new ProxyError(400, "dns_validation_failed", "无法验证 Base URL 的公网地址。");
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new ProxyError(400, "dns_validation_failed", "无法验证 Base URL 的公网地址。");
    }
    if (addresses.some((address) => !isPublicIp(address))) {
      throw new ProxyError(400, "unsafe_target", "Base URL 解析到了本地或内网地址。");
    }
  }

  return chatCompletionsUrl(url);
}

export async function resolveWithDns(hostname, resolver = dns, signal) {
  const results = await Promise.allSettled([
    runAbortable(() => resolver.resolve4(hostname), signal),
    runAbortable(() => resolver.resolve6(hostname), signal),
  ]);
  const rawAddresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const addresses = rawAddresses.filter(
    (address) => typeof address === "string" && isIpLiteral(address),
  );
  if (addresses.length > 0) return [...new Set(addresses)];
  throw new Error("DNS lookup returned no addresses");
}

async function resolveWithPublicDns(hostname, fetchImpl = fetch, signal) {
  const results = await Promise.allSettled(
    PUBLIC_DNS_ENDPOINTS.flatMap((endpoint) =>
      ["A", "AAAA"].map((type) =>
        runAbortable(async () => {
          const url = new URL(endpoint);
          url.searchParams.set("name", hostname);
          url.searchParams.set("type", type);
          const response = await fetchImpl(url, {
            headers: { accept: "application/dns-json" },
            redirect: "error",
            signal,
          });
          if (!response.ok) throw new Error("Public DNS request failed");
          const payload = await response.json();
          if (payload?.Status !== 0 || !Array.isArray(payload.Answer)) return [];
          const recordType = type === "A" ? 1 : 28;
          return payload.Answer.filter(
            (answer) =>
              answer?.type === recordType && typeof answer.data === "string",
          ).map((answer) => answer.data);
        }, signal),
      ),
    ),
  );
  const addresses = results
    .flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    )
    .filter((address) => typeof address === "string" && isIpLiteral(address));
  if (addresses.length > 0) return [...new Set(addresses)];
  throw new Error("Public DNS lookup returned no addresses");
}

export async function resolvePublicHostname(
  hostname,
  { resolver = dns, fetchImpl = fetch, signal } = {},
) {
  let addresses;
  try {
    addresses = await resolveWithDns(hostname, resolver, signal);
  } catch {
    return resolveWithPublicDns(hostname, fetchImpl, signal);
  }
  // Proxy/TUN DNS can mix reserved 198.18/15 answers with public A/AAAA answers.
  // Recheck only when every non-synthetic answer is already public; any ordinary
  // private answer must remain visible to validation and fail closed.
  if (
    addresses.some(isProxySyntheticIpv4) &&
    addresses.every(
      (address) => isProxySyntheticIpv4(address) || isPublicIp(address),
    )
  ) {
    return resolveWithPublicDns(hostname, fetchImpl, signal);
  }
  return addresses;
}

function readPayload(payload) {
  const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  if (!baseUrl || !model || !apiKey) {
    throw new ProxyError(400, "missing_settings", "请填写 Base URL、Model 和 API Key。");
  }
  if (messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw new ProxyError(400, "invalid_messages", "消息数量无效或超过限制。");
  }

  const normalizedMessages = messages.map((message) => {
    const role = message?.role;
    const content = typeof message?.content === "string" ? message.content : "";
    if (
      (role !== "user" && role !== "assistant") ||
      !content.trim() ||
      content.length > MAX_CONTENT_LENGTH
    ) {
      throw new ProxyError(400, "invalid_messages", "消息格式无效或内容过长。");
    }
    return { role, content };
  });

  return { baseUrl, model, apiKey, messages: normalizedMessages };
}

export function createProxyHandler({
  fetchImpl = fetch,
  resolveHostname = resolvePublicHostname,
  dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
  timeoutMs = 30_000,
} = {}) {
  return async function handleProxyRequest(request) {
    try {
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > MAX_BODY_LENGTH) {
        throw new ProxyError(413, "request_too_large", "请求内容过大。");
      }

      let rawPayload;
      try {
        rawPayload = await request.json();
      } catch {
        throw new ProxyError(400, "invalid_json", "请求格式无效。");
      }
      const payload = readPayload(rawPayload);
      const dnsScope = createAbortScope(request.signal, dnsTimeoutMs);
      let endpoint;
      try {
        endpoint = await validateBaseUrl(payload.baseUrl, resolveHostname, {
          signal: dnsScope.signal,
        });
      } finally {
        dnsScope.dispose();
      }

      const upstreamScope = createAbortScope(request.signal, timeoutMs);

      let upstream;
      try {
        upstream = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${payload.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": "Quiet-Chat/1.0 (+https://quiet-chat-lite-20260712.jiaoling.chatgpt.site)",
          },
          body: JSON.stringify({
            model: payload.model,
            messages: payload.messages,
            stream: false,
          }),
          redirect: "error",
          signal: upstreamScope.signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new ProxyError(504, "upstream_timeout", "上游模型响应超时。");
        }
        throw new ProxyError(502, "upstream_network", "站点服务器无法连接该模型服务；正在尝试浏览器兼容回退。");
      } finally {
        upstreamScope.dispose();
      }

      const upstreamResponse = await captureUpstreamResponse(upstream);
      const responsePayload = parseResponseJson(upstreamResponse);

      if (upstream.status === 401 || upstream.status === 403) {
        throw new ProxyError(
          401,
          "upstream_auth",
          "鉴权失败，请检查 API Key。",
          upstreamResponse,
        );
      }
      if (upstream.status === 429) {
        throw new ProxyError(
          429,
          "upstream_rate_limit",
          "上游服务限流，请稍后重试。",
          upstreamResponse,
        );
      }
      if (!upstream.ok) {
        throw new ProxyError(
          502,
          "upstream_error",
          `上游服务返回错误状态 ${upstream.status}。`,
          upstreamResponse,
        );
      }

      if (!responsePayload) {
        throw new ProxyError(
          502,
          "invalid_upstream_response",
          "模型服务返回了无效 JSON。",
          upstreamResponse,
        );
      }
      const message = responsePayload?.choices?.[0]?.message;
      if (message?.tool_calls || message?.function_call) {
        throw new ProxyError(
          422,
          "tool_calls_unsupported",
          "当前版本不支持工具调用响应。",
          upstreamResponse,
        );
      }
      if (typeof message?.content !== "string") {
        throw new ProxyError(
          502,
          "invalid_upstream_response",
          "模型服务返回了无法识别的响应。",
          upstreamResponse,
        );
      }

      return Response.json({ content: message.content, upstreamResponse });
    } catch (error) {
      if (error instanceof ProxyError) {
        return jsonError(
          error.status,
          error.code,
          error.message,
          error.upstreamResponse,
        );
      }
      return jsonError(500, "proxy_error", "请求处理失败，请稍后重试。");
    }
  };
}
