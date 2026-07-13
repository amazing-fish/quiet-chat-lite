import assert from "node:assert/strict";
import test from "node:test";

import { requestChatWithFallback } from "../app/lib/chat-request.mjs";

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

test("direct fallback runs only after the Site proxy reports an upstream network failure", async () => {
  let directRequest;
  const traces = [];
  const result = await requestChatWithFallback(request, {
    proxyFetch: async () =>
      Response.json(
        { error: { code: "upstream_network", message: "无法连接上游。" } },
        { status: 502 },
      ),
    directFetch: async (url, init) => {
      directRequest = { url: String(url), init, body: JSON.parse(init.body) };
      return Response.json({ choices: [{ message: { content: "直连成功" } }] });
    },
    requestId: "request-1",
    onTrace: (trace) => traces.push(trace),
  });

  assert.equal(result.content, "直连成功");
  assert.equal(result.transport, "direct");
  assert.equal(directRequest.url, "https://77code.cn/v1/chat/completions");
  assert.equal(directRequest.init.headers.authorization, "Bearer session-secret");
  assert.deepEqual(directRequest.body, {
    model: "model-next",
    messages: request.messages,
    stream: false,
  });
  assert.equal(traces.at(-1).id, "request-1:direct");
  assert.equal(traces.at(-1).state, "success");
  assert.equal(traces.at(-1).status, 200);
  assert.equal(traces.at(-1).request.headers.authorization, "Bearer [已隐藏]");
  assert.doesNotMatch(JSON.stringify(traces), /session-secret/);
});

test("proxy diagnostics expose the request and response without exposing the API key", async () => {
  const traces = [];
  await requestChatWithFallback(request, {
    proxyFetch: async () => Response.json({
      content: "代理成功",
      upstreamResponse: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: '{"choices":[{"message":{"content":"代理成功"}}]}',
      },
    }),
    requestId: "request-2",
    onTrace: (trace) => traces.push(trace),
  });

  const completed = traces.at(-1);
  assert.equal(completed.id, "request-2:proxy");
  assert.equal(completed.state, "success");
  assert.equal(completed.targetUrl, "https://77code.cn/v1/chat/completions");
  assert.equal(completed.response.upstreamResponse.status, 200);
  assert.equal(
    completed.response.upstreamResponse.body,
    '{"choices":[{"message":{"content":"代理成功"}}]}',
  );
  assert.equal(completed.request.body.apiKey, "[已隐藏]");
  assert.doesNotMatch(JSON.stringify(completed), /session-secret/);
});

test("a bare OpenAI-compatible origin uses the standard v1 chat completions endpoint", async () => {
  let directUrl;
  await requestChatWithFallback(
    { ...request, baseUrl: "https://77code.cn" },
    {
      proxyFetch: async () =>
        Response.json({ error: { code: "upstream_network" } }, { status: 502 }),
      directFetch: async (url) => {
        directUrl = String(url);
        return Response.json({ choices: [{ message: { content: "成功" } }] });
      },
    },
  );

  assert.equal(directUrl, "https://77code.cn/v1/chat/completions");
});

test("authentication errors never trigger direct fallback", async () => {
  let directCalls = 0;
  await assert.rejects(
    () =>
      requestChatWithFallback(request, {
        proxyFetch: async () =>
          Response.json(
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

test("a proxy connection failure without server validation never triggers direct fallback", async () => {
  let directCalls = 0;
  await assert.rejects(
    () =>
      requestChatWithFallback(request, {
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

test("direct tool-call responses remain unsupported", async () => {
  await assert.rejects(
    () =>
      requestChatWithFallback(request, {
        proxyFetch: async () =>
          Response.json({ error: { code: "upstream_network" } }, { status: 502 }),
        directFetch: async () =>
          Response.json({ choices: [{ message: { tool_calls: [{ id: "call-1" }] } }] }),
      }),
    /不支持工具调用/,
  );
});
