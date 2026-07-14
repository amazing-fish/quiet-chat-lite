import { responseErrorMessage } from "./client-errors.mjs";
import { chatCompletionsUrl } from "./chat-endpoint.mjs";
import {
  createChatEventParser,
  createOpenAIStreamParser,
  isEventStream,
  normalizeTokenUsage,
  StreamProtocolError,
} from "./chat-stream.mjs";
import { randomId } from "./id.mjs";

const REDACTED_SECRET = "[已隐藏]";

class ChatRequestError extends Error {
  constructor(message, { allowDirectFallback = false, traceResponse = null } = {}) {
    super(message);
    this.name = "ChatRequestError";
    this.allowDirectFallback = allowDirectFallback;
    this.traceResponse = traceResponse;
  }
}

function timestamp() {
  return new Date().toISOString();
}

function elapsed(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function emitTrace(onTrace, trace) {
  if (typeof onTrace !== "function") return;
  try {
    onTrace(trace);
  } catch {
    // Diagnostics must never interrupt a chat request.
  }
}

function proxyRequestDetails(request) {
  return {
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: { ...request, apiKey: REDACTED_SECRET },
  };
}

function directRequestDetails(request) {
  return {
    headers: {
      authorization: `Bearer ${REDACTED_SECRET}`,
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
    },
    body: {
      model: request.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
    },
  };
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

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function upstreamMessage(payload) {
  const message = payload?.error?.message;
  return typeof message === "string" ? message.slice(0, 240) : "";
}

function streamFailure(event) {
  const error = new StreamProtocolError(
    event.code || "stream_error",
    event.message || "流式响应意外中断。",
    event.status || 502,
  );
  return error;
}

async function consumeEventStream(
  response,
  createParser,
  { onDelta, onUsage, onActivity },
) {
  if (!response.body) {
    throw new StreamProtocolError(
      "invalid_stream_response",
      "响应没有可读取的流。",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rawBody = "";
  let content = "";
  let usage = null;
  let finishReason = null;
  let metadata = null;
  let completed = false;

  const parser = createParser((event) => {
    if (event.type === "meta") metadata = event;
    if (event.type === "delta" && typeof event.content === "string") {
      content += event.content;
      onDelta?.(event.content, content);
    }
    if (event.type === "usage") {
      usage = {
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        source: event.source || "provider",
      };
      onUsage?.(usage);
    }
    if (event.type === "done") {
      finishReason = event.finishReason ?? null;
      completed = true;
    }
    if (event.type === "error") throw streamFailure(event);
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      const text = decoder.decode(value, { stream: true });
      rawBody += text;
      parser.feed(text);
      if (completed) {
        try {
          await reader.cancel("stream completed");
        } catch {}
        break;
      }
    }
    const tail = decoder.decode();
    rawBody += tail;
    parser.feed(tail);
    parser.end();
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {}
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.partialContent = content;
    throw failure;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  if (!content) {
    throw new StreamProtocolError(
      "empty_stream_response",
      "模型服务没有返回文本内容。",
    );
  }
  return { content, usage, finishReason, metadata, rawBody };
}

function traceResponse(response, rawBody, extra = {}) {
  return {
    ...extra,
    upstreamResponse: {
      status: response.status,
      statusText: response.statusText,
      headers: visibleResponseHeaders(response.headers),
      body: rawBody,
    },
  };
}

function jsonResult(payload, callbacks) {
  const message = payload?.choices?.[0]?.message;
  if (message?.tool_calls || message?.function_call) {
    throw new Error("当前版本不支持工具调用响应。");
  }
  const content = typeof payload?.content === "string"
    ? payload.content
    : message?.content;
  if (typeof content !== "string") {
    throw new Error(responseErrorMessage(502));
  }
  callbacks.onDelta?.(content, content);
  const usage = normalizeTokenUsage(payload?.usage);
  if (usage) callbacks.onUsage?.(usage);
  return {
    content,
    usage,
    finishReason: payload?.choices?.[0]?.finish_reason ?? null,
  };
}

async function proxyChatStream(request, options, traceContext) {
  const startedAt = performance.now();
  const trace = {
    id: `${traceContext.requestId}:proxy`,
    requestId: traceContext.requestId,
    startedAt: timestamp(),
    transport: "proxy",
    method: "POST",
    url: "/api/chat",
    targetUrl: String(chatCompletionsUrl(request.baseUrl)),
    state: "pending",
    durationMs: 0,
    status: null,
    request: proxyRequestDetails(request),
    response: null,
  };
  emitTrace(traceContext.onTrace, trace);

  let response;
  try {
    response = await options.proxyFetch("/api/chat", {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
  } catch (error) {
    emitTrace(traceContext.onTrace, {
      ...trace,
      state: options.signal?.aborted ? "stopped" : "error",
      durationMs: elapsed(startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (!response.ok) {
    const rawBody = await response.text();
    const payload = parseJsonText(rawBody);
    emitTrace(traceContext.onTrace, {
      ...trace,
      state: "error",
      durationMs: elapsed(startedAt),
      status: response.status,
      response: payload,
    });
    throw new ChatRequestError(
      responseErrorMessage(response.status || 502, upstreamMessage(payload)),
      { allowDirectFallback: payload?.error?.code === "upstream_network" },
    );
  }

  emitTrace(traceContext.onTrace, {
    ...trace,
    state: "streaming",
    durationMs: elapsed(startedAt),
    status: response.status,
    response: { streaming: true },
  });

  try {
    if (!isEventStream(response.headers)) {
      const rawBody = await response.text();
      const payload = parseJsonText(rawBody);
      const result = jsonResult(payload, options);
      emitTrace(traceContext.onTrace, {
        ...trace,
        state: "success",
        durationMs: elapsed(startedAt),
        status: response.status,
        response: payload?.upstreamResponse
          ? { upstreamResponse: payload.upstreamResponse, usage: result.usage }
          : traceResponse(response, rawBody, { usage: result.usage }),
      });
      return { ...result, transport: "proxy" };
    }

    const result = await consumeEventStream(
      response,
      createChatEventParser,
      options,
    );
    const upstream = result.metadata?.upstreamResponse;
    emitTrace(traceContext.onTrace, {
      ...trace,
      state: "success",
      durationMs: elapsed(startedAt),
      status: response.status,
      response: {
        streaming: true,
        responseKind: result.metadata?.responseKind ?? "normalized-sse",
        usage: result.usage,
        upstreamResponse: {
          status: upstream?.status ?? response.status,
          statusText: upstream?.statusText ?? response.statusText,
          headers: upstream?.headers ?? visibleResponseHeaders(response.headers),
          body: typeof upstream?.body === "string" ? upstream.body : result.rawBody,
        },
      },
    });
    return {
      content: result.content,
      usage: result.usage,
      finishReason: result.finishReason,
      transport: "proxy",
    };
  } catch (error) {
    emitTrace(traceContext.onTrace, {
      ...trace,
      state: options.signal?.aborted ? "stopped" : "error",
      durationMs: elapsed(startedAt),
      status: response.status,
      response: {
        streaming: true,
        partialContent: error?.partialContent ?? "",
      },
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function directChatStream(request, options, traceContext) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let timeout;
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), options.directTimeoutMs);
  };
  resetTimeout();
  const url = String(chatCompletionsUrl(request.baseUrl));
  const startedAt = performance.now();
  const trace = {
    id: `${traceContext.requestId}:direct`,
    requestId: traceContext.requestId,
    startedAt: timestamp(),
    transport: "direct",
    method: "POST",
    url,
    targetUrl: url,
    state: "pending",
    durationMs: 0,
    status: null,
    request: directRequestDetails(request),
    response: null,
  };
  emitTrace(traceContext.onTrace, trace);

  let response;
  try {
    response = await options.directFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      redirect: "error",
      signal: controller.signal,
    });
    resetTimeout();

    if (!response.ok) {
      const rawBody = await response.text();
      clearTimeout(timeout);
      const payload = parseJsonText(rawBody);
      throw new ChatRequestError(
        responseErrorMessage(response.status, upstreamMessage(payload)),
        { traceResponse: traceResponse(response, rawBody) },
      );
    }

    emitTrace(traceContext.onTrace, {
      ...trace,
      state: "streaming",
      durationMs: elapsed(startedAt),
      status: response.status,
      response: { streaming: true },
    });

    let result;
    if (isEventStream(response.headers)) {
      result = await consumeEventStream(
        response,
        createOpenAIStreamParser,
        { ...options, onActivity: resetTimeout },
      );
    } else {
      const rawBody = await response.text();
      clearTimeout(timeout);
      const payload = parseJsonText(rawBody);
      result = { ...jsonResult(payload, options), rawBody };
    }

    emitTrace(traceContext.onTrace, {
      ...trace,
      state: "success",
      durationMs: elapsed(startedAt),
      status: response.status,
      response: traceResponse(response, result.rawBody, {
        streaming: isEventStream(response.headers),
        usage: result.usage,
      }),
    });
    return {
      content: result.content,
      usage: result.usage,
      finishReason: result.finishReason,
      transport: "direct",
    };
  } catch (error) {
    clearTimeout(timeout);
    emitTrace(traceContext.onTrace, {
      ...trace,
      state: options.signal?.aborted ? "stopped" : "error",
      durationMs: elapsed(startedAt),
      status: response?.status ?? null,
      response: error instanceof ChatRequestError ? error.traceResponse : null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * @param {Record<string, any>} request
 * @param {{
 *   proxyFetch?: typeof fetch,
 *   directFetch?: typeof fetch,
 *   signal?: AbortSignal,
 *   directTimeoutMs?: number,
 *   requestId?: string,
 *   onTrace?: (trace: any) => void,
 *   onDelta?: (delta: string, content: string) => void,
 *   onUsage?: (usage: any) => void,
 * }} [options]
 */
export async function requestChatStreamWithFallback(
  request,
  {
    proxyFetch = fetch,
    directFetch = fetch,
    signal,
    directTimeoutMs = 30_000,
    requestId = randomId(),
    onTrace,
    onDelta,
    onUsage,
  } = {},
) {
  const options = {
    proxyFetch,
    directFetch,
    signal,
    directTimeoutMs,
    onDelta,
    onUsage,
  };
  const traceContext = { requestId, onTrace };

  try {
    return await proxyChatStream(request, options, traceContext);
  } catch (error) {
    if (!error?.allowDirectFallback) throw error;
  }

  try {
    return await directChatStream(request, options, traceContext);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        "站点代理暂时无法连接该模型服务，且该服务未允许浏览器跨域直连。请稍后重试，或联系 API 服务商允许来自本站的请求。",
      );
    }
    throw error;
  }
}
