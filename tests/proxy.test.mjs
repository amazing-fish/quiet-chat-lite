import assert from "node:assert/strict";
import test from "node:test";

import {
  createProxyHandler,
  resolveWithDns,
  validateBaseUrl,
} from "../app/lib/proxy.mjs";
import { createChatEventParser } from "../app/lib/chat-stream.mjs";

const publicResolver = async () => ["8.8.8.8"];

function openAiStream(payloads) {
  const body = payloads
    .map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

async function readChatEvents(response) {
  const events = [];
  const parser = createChatEventParser((event) => events.push(event));
  parser.feed(await response.text());
  parser.end();
  return events;
}

test("runtime DNS validation accepts an A-only public hostname", async () => {
  const addresses = await resolveWithDns("77code.cn", {
    resolve4: async () => ["77.83.241.109"],
    resolve6: async () => {
      throw new Error("ENODATA");
    },
  });

  assert.deepEqual(addresses, ["77.83.241.109"]);
});

test("proxy rejects non-HTTPS, local, private, credentialed, and internally-resolved targets", async () => {
  const rejected = [
    "http://api.example/v1",
    "file:///tmp/model",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.1/v1",
    "https://172.16.2.3/v1",
    "https://192.168.1.8/v1",
    "https://169.254.169.254/latest",
    "https://[::1]/v1",
    "https://[fc00::1]/v1",
    "https://user:pass@api.example/v1",
    "https://service.internal/v1",
  ];

  for (const target of rejected) {
    await assert.rejects(() => validateBaseUrl(target, publicResolver));
  }

  await assert.rejects(() =>
    validateBaseUrl("https://rebind.example/v1", async () => ["10.1.2.3"]),
  );
});

test("proxy appends the chat completions path and forwards only the supported request shape", async () => {
  let upstream;
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    fetchImpl: async (url, init) => {
      upstream = { url: String(url), init, body: JSON.parse(init.body) };
      return openAiStream([
        { choices: [{ delta: { content: "你" } }] },
        { choices: [{ delta: { content: "好" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
        "[DONE]",
      ]);
    },
  });

  const response = await handler(
    new Request("https://site.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://api.example/v1",
        model: "model-next",
        apiKey: "secret",
        messages: [
          { role: "user", content: "第一问" },
          { role: "assistant", content: "第一答" },
          { role: "user", content: "第二问" },
        ],
        ignored: "not-forwarded",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(upstream.url, "https://api.example/v1/chat/completions");
  assert.equal(upstream.init.headers.authorization, "Bearer secret");
  assert.deepEqual(upstream.body, {
    model: "model-next",
    messages: [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ],
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const events = await readChatEvents(response);
  assert.deepEqual(events.map((event) => event.type), [
    "meta",
    "delta",
    "delta",
    "usage",
    "done",
  ]);
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.content).join(""), "你好");
  assert.deepEqual(events.find((event) => event.type === "usage"), {
    type: "usage",
    promptTokens: 8,
    completionTokens: 2,
    totalTokens: 10,
    source: "provider",
  });
  assert.equal(events.at(-1).finishReason, "stop");
});

test("proxy maps a bare public origin to the standard v1 endpoint", async () => {
  let upstreamUrl;
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    fetchImpl: async (url) => {
      upstreamUrl = String(url);
      return Response.json({ choices: [{ message: { content: "你好" } }] });
    },
  });

  const response = await handler(
    new Request("https://site.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://77code.cn",
        model: "grok-4.5",
        apiKey: "secret",
        messages: [{ role: "user", content: "测试" }],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamUrl, "https://77code.cn/v1/chat/completions");
  assert.equal((await readChatEvents(response)).find((event) => event.type === "delta").content, "你好");
});

test("proxy maps authentication, network, timeout, invalid response, and tool calls", async (t) => {
  const cases = [
    {
      name: "authentication",
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
      status: 401,
      code: "upstream_auth",
    },
    {
      name: "network",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      status: 502,
      code: "upstream_network",
    },
    {
      name: "timeout",
      fetchImpl: async () => {
        throw new DOMException("aborted", "AbortError");
      },
      status: 504,
      code: "upstream_timeout",
    },
    {
      name: "invalid response",
      fetchImpl: async () => Response.json({ result: "unexpected" }),
      status: 502,
      code: "invalid_upstream_response",
    },
    {
      name: "tool calls",
      fetchImpl: async () =>
        Response.json({ choices: [{ message: { tool_calls: [{ id: "call-1" }] } }] }),
      status: 422,
      code: "tool_calls_unsupported",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const handler = createProxyHandler({
        resolveHostname: publicResolver,
        fetchImpl: item.fetchImpl,
      });
      const response = await handler(
        new Request("https://site.example/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseUrl: "https://api.example/v1",
            model: "model-one",
            apiKey: "secret",
            messages: [{ role: "user", content: "测试" }],
          }),
        }),
      );

      assert.equal(response.status, item.status);
      const responseBody = await response.json();
      assert.equal(responseBody.error.code, item.code);
      if (item.name !== "network" && item.name !== "timeout") {
        assert.equal(typeof responseBody.upstreamResponse.body, "string");
      }
    });
  }
});

test("proxy preserves the exact upstream error body for diagnostics", async () => {
  const rawBody = '{"error":{"message":"model not found"},"request_id":"req-raw-1"}\n';
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    fetchImpl: async () => new Response(rawBody, {
      status: 404,
      statusText: "Not Found",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-raw-1",
        "set-cookie": "session=must-not-leak",
      },
    }),
  });

  const response = await handler(new Request("https://site.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://api.example/v1",
      model: "missing-model",
      apiKey: "secret",
      messages: [{ role: "user", content: "测试" }],
    }),
  }));
  const responseBody = await response.json();

  assert.equal(responseBody.upstreamResponse.status, 404);
  assert.equal(responseBody.upstreamResponse.statusText, "Not Found");
  assert.equal(responseBody.upstreamResponse.body, rawBody);
  assert.equal(responseBody.upstreamResponse.headers["x-request-id"], "req-raw-1");
  assert.equal(responseBody.upstreamResponse.headers["set-cookie"], undefined);
  assert.doesNotMatch(JSON.stringify(responseBody), /must-not-leak/);
});

test("proxy cancels the provider stream when SSE parsing fails", async () => {
  let cancelReason;
  const encoder = new TextEncoder();
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: not-json\n\n"));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });

  const response = await handler(new Request("https://site.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://api.example/v1",
      model: "model-one",
      apiKey: "secret",
      messages: [{ role: "user", content: "测试" }],
    }),
  }));
  const events = await readChatEvents(response);

  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).code, "invalid_upstream_stream");
  assert.equal(cancelReason?.code, "invalid_upstream_stream");
});

test("proxy timeout remains active while a JSON fallback body is stalled", async () => {
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    timeoutMs: 10,
    fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => {
          controller.error(new DOMException("timed out", "AbortError"));
        }, { once: true });
      },
    }), { headers: { "content-type": "application/json" } }),
  });

  const response = await handler(new Request("https://site.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://api.example/v1",
      model: "model-one",
      apiKey: "secret",
      messages: [{ role: "user", content: "测试" }],
    }),
  }));

  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "upstream_timeout");
});

test("proxy emits a timeout event when an SSE provider stalls before its first chunk", async () => {
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    timeoutMs: 10,
    fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => {
          controller.error(new DOMException("timed out", "AbortError"));
        }, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });

  const response = await handler(new Request("https://site.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://api.example/v1",
      model: "model-one",
      apiKey: "secret",
      messages: [{ role: "user", content: "测试" }],
    }),
  }));
  const events = await readChatEvents(response);

  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).code, "upstream_timeout");
  assert.equal(events.at(-1).status, 504);
});

test("proxy closes on upstream DONE even when the provider keeps the connection open", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    timeoutMs: 10,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n") + "\n"));
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });

  const response = await handler(new Request("https://site.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://api.example/v1",
      model: "model-one",
      apiKey: "secret",
      messages: [{ role: "user", content: "测试" }],
    }),
  }));
  const events = await readChatEvents(response);

  assert.equal(events.at(-1).type, "done");
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(cancelled, true);
});
