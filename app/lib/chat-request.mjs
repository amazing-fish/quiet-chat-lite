import { responseErrorMessage } from "./client-errors.mjs";
import { chatCompletionsUrl } from "./chat-endpoint.mjs";
import { randomId } from "./id.mjs";

const REDACTED_SECRET = "[已隐藏]";

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
    headers: { "content-type": "application/json" },
    body: {
      ...request,
      apiKey: request.apiKey ? REDACTED_SECRET : "[由服务端读取]",
    },
  };
}

function directRequestDetails(request) {
  return {
    headers: {
      authorization: `Bearer ${REDACTED_SECRET}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: {
      model: request.model,
      messages: request.messages,
      stream: false,
    },
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
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

async function directChatRequest(request, fetchImpl, signal, timeoutMs, traceContext) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = String(chatCompletionsUrl(request.baseUrl));
  const startedAt = performance.now();
  let responseStatus = null;
  let responsePayload = null;
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

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
      }),
      redirect: "error",
      signal: controller.signal,
    });
    const rawBody = await response.text();
    const payload = parseJsonText(rawBody);
    const upstreamResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: visibleResponseHeaders(response.headers),
      body: rawBody,
    };
    responseStatus = response.status;
    responsePayload = { upstreamResponse };
    emitTrace(traceContext.onTrace, {
      ...trace,
      state: response.ok ? "success" : "error",
      durationMs: elapsed(startedAt),
      status: response.status,
      response: { upstreamResponse },
    });
    const message = payload?.choices?.[0]?.message;

    if (message?.tool_calls || message?.function_call) {
      throw new Error("当前版本不支持工具调用响应。");
    }
    if (!response.ok) {
      throw new Error(responseErrorMessage(response.status, upstreamMessage(payload)));
    }
    if (typeof message?.content !== "string") {
      throw new Error(responseErrorMessage(502));
    }
    return { content: message.content, transport: "direct" };
  } catch (error) {
    emitTrace(traceContext.onTrace, {
      ...trace,
      state: "error",
      durationMs: elapsed(startedAt),
      status: responseStatus,
      response: responsePayload,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
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
 * }} [options]
 */
export async function requestChatWithFallback(
  request,
  {
    proxyFetch = fetch,
    directFetch = fetch,
    signal,
    directTimeoutMs = 30_000,
    requestId = randomId(),
    onTrace,
  } = {},
) {
  const proxyStartedAt = performance.now();
  const proxyTrace = {
    id: `${requestId}:proxy`,
    requestId,
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
  emitTrace(onTrace, proxyTrace);

  let proxyResponse;
  try {
    proxyResponse = await proxyFetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    emitTrace(onTrace, {
      ...proxyTrace,
      state: "error",
      durationMs: elapsed(proxyStartedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const proxyPayload = await readJson(proxyResponse);
  emitTrace(onTrace, {
    ...proxyTrace,
    state: proxyResponse.ok ? "success" : "error",
    durationMs: elapsed(proxyStartedAt),
    status: proxyResponse.status,
    response: proxyPayload,
  });

  if (proxyResponse.ok && typeof proxyPayload.content === "string") {
    return { content: proxyPayload.content, transport: "proxy" };
  }
  if (proxyPayload?.error?.code !== "upstream_network") {
    throw new Error(
      responseErrorMessage(proxyResponse.status || 502, upstreamMessage(proxyPayload)),
    );
  }

  if (!request.apiKey?.trim()) {
    throw new Error(
      "站点代理暂时无法连接该模型服务。已保存的 API Key 不会返回浏览器，因此未尝试浏览器直连。",
    );
  }

  try {
    return await directChatRequest(request, directFetch, signal, directTimeoutMs, {
      requestId,
      onTrace,
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("站点代理暂时无法连接该模型服务，且该服务未允许浏览器跨域直连。请稍后重试，或联系 API 服务商允许来自本站的请求。");
    }
    throw error;
  }
}
