import assert from "node:assert/strict";
import test from "node:test";

import { requestChatStreamWithFallback } from "../app/lib/chat-request.mjs";
import { encodeChatEvent } from "../app/lib/chat-stream.mjs";

const request = {
  baseUrl: "https://77code.cn/v1",
  model: "model-next",
  apiKey: "session-secret",
  messages: [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ],
};

function chatEventStream(events) {
  return new Response(
    events.map(({ type, ...data }) => encodeChatEvent(type, data)).join(""),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

function openAiStream(payloads) {
  return new Response(
    payloads
      .map((payload) =>
        `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`
      )
      .join(""),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

test("proxy streaming emits incremental text and provider usage", async () => {
  const deltas = [];
  const usages = [];
  const traces = [];
  const result = await requestChatStreamWithFallback(request, {
    proxyFetch: async () => chatEventStream([
      {
        type: "meta",
        transport: "proxy",
        responseKind: "normalized-sse",
        upstreamResponse: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/event-stream" },
        },
      },
      { type: "delta", content: "代理" },
      { type: "delta", content: "成功" },
      {
        type: "usage",
        promptTokens: 12,
        completionTokens: 2,
        totalTokens: 14,
        source: "provider",
      },
      { type: "done", finishReason: "stop" },
    ]),
    requestId: "request-proxy",
    onDelta: (delta, content) => deltas.push({ delta, content }),
    onUsage: (usage) => usages.push(usage),
    onTrace: (trace) => traces.push(trace),
  });

  assert.deepEqual(deltas, [
    { delta: "代理", content: "代理" },
    { delta: "成功", content: "代理成功" },
  ]);
  assert.deepEqual(usages, [{
    promptTokens: 12,
    completionTokens: 2,
    totalTokens: 14,
    source: "provider",
  }]);
  assert.deepEqual(result, {
    content: "代理成功",
    usage: usages[0],
    finishReason: "stop",
    transport: "proxy",
  });
  assert.deepEqual(traces.map((trace) => trace.state), [
    "pending",
    "streaming",
    "success",
  ]);
  assert.match(traces.at(-1).response.upstreamResponse.body, /event: delta/);
  assert.equal(traces.at(-1).request.body.apiKey, "[已隐藏]");
  assert.doesNotMatch(JSON.stringify(traces), /session-secret/);
});

test("direct fallback runs only after the Site proxy validates an upstream network failure", async () => {
  let directRequest;
  const traces = [];
  const result = await requestChatStreamWithFallback(request, {
    proxyFetch: async () => Response.json(
      { error: { code: "upstream_network", message: "无法连接上游。" } },
      { status: 502 },
    ),
    directFetch: async (url, init) => {
      directRequest = { url: String(url), init, body: JSON.parse(init.body) };
      return openAiStream([
        { choices: [{ delta: { content: "直连成功" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
        "[DONE]",
      ]);
    },
    requestId: "request-direct",
    onTrace: (trace) => traces.push(trace),
  });

  assert.equal(result.content, "直连成功");
  assert.equal(result.transport, "direct");
  assert.equal(result.usage.totalTokens, 13);
  assert.equal(directRequest.url, "https://77code.cn/v1/chat/completions");
  assert.equal(directRequest.init.headers.authorization, "Bearer session-secret");
  assert.deepEqual(directRequest.body, {
    model: "model-next",
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(traces.at(-1).id, "request-direct:direct");
  assert.equal(traces.at(-1).state, "success");
  assert.equal(traces.at(-1).request.headers.authorization, "Bearer [已隐藏]");
  assert.doesNotMatch(JSON.stringify(traces), /session-secret/);
});

test("a bare OpenAI-compatible origin uses the standard v1 endpoint", async () => {
  let directUrl;
  await requestChatStreamWithFallback(
    { ...request, baseUrl: "https://77code.cn" },
    {
      proxyFetch: async () =>
        Response.json({ error: { code: "upstream_network" } }, { status: 502 }),
      directFetch: async (url) => {
        directUrl = String(url);
        return openAiStream([
          { choices: [{ delta: { content: "成功" } }] },
          "[DONE]",
        ]);
      },
    },
  );

  assert.equal(directUrl, "https://77code.cn/v1/chat/completions");
});

test("authentication errors and unvalidated proxy failures never trigger direct fallback", async (t) => {
  await t.test("authentication", async () => {
    let directCalls = 0;
    await assert.rejects(
      () => requestChatStreamWithFallback(request, {
        proxyFetch: async () => Response.json(
          { error: { code: "upstream_auth", message: "unauthorized" } },
          { status: 401 },
        ),
        directFetch: async () => {
          directCalls += 1;
          return Response.json({});
        },
      }),
      /鉴权失败，请检查 API Key/,
    );
    assert.equal(directCalls, 0);
  });

  await t.test("proxy connection", async () => {
    let directCalls = 0;
    await assert.rejects(
      () => requestChatStreamWithFallback(request, {
        proxyFetch: async () => {
          throw new TypeError("site unavailable");
        },
        directFetch: async () => {
          directCalls += 1;
          return Response.json({});
        },
      }),
      TypeError,
    );
    assert.equal(directCalls, 0);
  });
});

test("a stream error after the first delta preserves partial text and never retries direct", async () => {
  let directCalls = 0;
  const accumulated = [];
  await assert.rejects(
    () => requestChatStreamWithFallback(request, {
      proxyFetch: async () => chatEventStream([
        { type: "meta", responseKind: "normalized-sse" },
        { type: "delta", content: "已经生成" },
        { type: "error", code: "upstream_stream_error", message: "连接中断" },
      ]),
      directFetch: async () => {
        directCalls += 1;
        return Response.json({});
      },
      onDelta: (_delta, content) => accumulated.push(content),
    }),
    (error) => {
      assert.equal(error.message, "连接中断");
      assert.equal(error.partialContent, "已经生成");
      return true;
    },
  );
  assert.deepEqual(accumulated, ["已经生成"]);
  assert.equal(directCalls, 0);
});

test("caller abort cancels an active stream after preserving emitted text", async () => {
  const caller = new AbortController();
  let releaseDelta;
  const deltaReceived = new Promise((resolve) => {
    releaseDelta = resolve;
  });

  const pending = requestChatStreamWithFallback(request, {
    signal: caller.signal,
    proxyFetch: async (_url, init) => {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(encodeChatEvent("delta", { content: "保留" })));
          init.signal.addEventListener("abort", () => {
            controller.error(new DOMException("stopped", "AbortError"));
          }, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
    onDelta: () => releaseDelta(),
  });

  await deltaReceived;
  caller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.partialContent, "保留");
    return true;
  });
});

test("direct tool-call streams remain unsupported", async () => {
  await assert.rejects(
    () => requestChatStreamWithFallback(request, {
      proxyFetch: async () =>
        Response.json({ error: { code: "upstream_network" } }, { status: 502 }),
      directFetch: async () => openAiStream([
        { choices: [{ delta: { tool_calls: [{ id: "call-1" }] } }] },
        "[DONE]",
      ]),
    }),
    /不支持工具调用/,
  );
});
