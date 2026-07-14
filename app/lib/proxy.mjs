import { promises as dns } from "node:dns";

import { chatCompletionsUrl } from "./chat-endpoint.mjs";
import {
  createOpenAIStreamParser,
  encodeChatEvent,
  isEventStream,
  normalizeTokenUsage,
  StreamProtocolError,
} from "./chat-stream.mjs";

const MAX_MESSAGES = 100;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_BODY_LENGTH = 1_000_000;
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

function isPublicIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  const mappedIpv4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) return isPublicIpv4(mappedIpv4[1]);
  if (normalized === "::" || normalized === "::1") return false;
  if (/^(?:fc|fd)/.test(normalized)) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (/^ff/.test(normalized)) return false;
  if (/^2001:db8(?::|$)/.test(normalized)) return false;
  return /^[0-9a-f:]+$/.test(normalized) && normalized.includes(":");
}

export function isPublicIp(address) {
  return address.includes(":")
    ? isPublicIpv6(address)
    : isPublicIpv4(address);
}

function isIpLiteral(hostname) {
  return ipv4Parts(hostname) !== null || hostname.includes(":");
}

export async function validateBaseUrl(baseUrl, resolveHostname) {
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
      addresses = await resolveHostname(hostname);
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

export async function resolveWithDns(hostname, resolver = dns) {
  const results = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (addresses.length > 0) return [...new Set(addresses)];
  throw new Error("DNS lookup returned no addresses");
}

export async function resolvePublicHostname(hostname) {
  return resolveWithDns(hostname);
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

function streamResponse(body) {
  return new Response(body, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

function upstreamMetadata(response) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: visibleResponseHeaders(response.headers),
  };
}

function oneShotStream(upstreamResponse, responsePayload) {
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

  const events = [
    encodeChatEvent("meta", {
      transport: "proxy",
      upstreamResponse,
      responseKind: "json-fallback",
    }),
    encodeChatEvent("delta", { content: message.content }),
  ];
  const usage = normalizeTokenUsage(responsePayload?.usage);
  if (usage) events.push(encodeChatEvent("usage", usage));
  events.push(encodeChatEvent("done", {
    finishReason: responsePayload?.choices?.[0]?.finish_reason ?? null,
  }));
  return streamResponse(events.join(""));
}

function normalizedUpstreamStream(upstream, abortController, cleanup, requestSignal) {
  if (!upstream.body) {
    cleanup();
    throw new ProxyError(
      502,
      "invalid_upstream_response",
      "模型服务没有返回可读取的响应流。",
    );
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let cancelled = false;
  let cleaned = false;
  const finishCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };

  return new ReadableStream({
    async start(controller) {
      const enqueue = (type, data) => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(encodeChatEvent(type, data)));
      };
      enqueue("meta", {
        transport: "proxy",
        upstreamResponse: upstreamMetadata(upstream),
        responseKind: "normalized-sse",
      });
      const parser = createOpenAIStreamParser((event) => {
        const { type, ...data } = event;
        enqueue(type, data);
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.feed(decoder.decode());
        parser.end();
      } catch (error) {
        if (!cancelled && !requestSignal.aborted) {
          const streamError = error instanceof StreamProtocolError
            ? error
            : new StreamProtocolError(
              "upstream_stream_error",
              "模型服务的流式响应意外中断。",
            );
          enqueue("error", {
            status: streamError.status,
            code: streamError.code,
            message: streamError.message,
          });
        }
      } finally {
        finishCleanup();
        try {
          reader.releaseLock();
        } catch {}
        if (!cancelled) {
          try {
            controller.close();
          } catch {}
        }
      }
    },
    async cancel(reason) {
      cancelled = true;
      abortController.abort(reason);
      finishCleanup();
      try {
        await reader.cancel(reason);
      } catch {}
    },
  });
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   resolveHostname?: (hostname: string) => Promise<string[]>,
 *   timeoutMs?: number,
 * }} [options]
 */
export function createProxyHandler({
  fetchImpl = fetch,
  resolveHostname = resolvePublicHostname,
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
      const endpoint = await validateBaseUrl(payload.baseUrl, resolveHostname);
      const controller = new AbortController();
      const stopOnClientAbort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", stopOnClientAbort, { once: true });
      const cleanup = () =>
        request.signal.removeEventListener("abort", stopOnClientAbort);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let upstream;
      try {
        upstream = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${payload.apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            "user-agent": "Quiet-Chat/1.0 (+https://quiet-chat-lite-20260712.jiaoling.chatgpt.site)",
          },
          body: JSON.stringify({
            model: payload.model,
            messages: payload.messages,
            stream: true,
            stream_options: { include_usage: true },
          }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        cleanup();
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new ProxyError(504, "upstream_timeout", "上游模型响应超时。");
        }
        throw new ProxyError(
          502,
          "upstream_network",
          "站点服务器无法连接该模型服务；正在尝试浏览器兼容回退。",
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!upstream.ok) {
        cleanup();
        const upstreamResponse = await captureUpstreamResponse(upstream);
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
        throw new ProxyError(
          502,
          "upstream_error",
          `上游服务返回错误状态 ${upstream.status}。`,
          upstreamResponse,
        );
      }

      if (isEventStream(upstream.headers)) {
        return streamResponse(
          normalizedUpstreamStream(upstream, controller, cleanup, request.signal),
        );
      }

      cleanup();
      const upstreamResponse = await captureUpstreamResponse(upstream);
      const responsePayload = parseResponseJson(upstreamResponse);
      if (!responsePayload) {
        throw new ProxyError(
          502,
          "invalid_upstream_response",
          "模型服务返回了无效 JSON。",
          upstreamResponse,
        );
      }
      return oneShotStream(upstreamResponse, responsePayload);
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

