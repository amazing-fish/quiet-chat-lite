import assert from "node:assert/strict";
import test from "node:test";

import {
  createChatEventParser,
  createOpenAIStreamParser,
  encodeChatEvent,
  normalizeTokenUsage,
  StreamProtocolError,
} from "../app/lib/chat-stream.mjs";

function feedUtf8(parser, text, splitPoints = []) {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  let offset = 0;
  for (const point of [...splitPoints, bytes.length]) {
    parser.feed(decoder.decode(bytes.slice(offset, point), { stream: point < bytes.length }));
    offset = point;
  }
  parser.feed(decoder.decode());
  parser.end();
}

test("OpenAI SSE parsing survives UTF-8 and event boundaries", () => {
  const events = [];
  const parser = createOpenAIStreamParser((event) => events.push(event));
  const body = [
    'data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
    "",
    "data: [DONE]",
    "",
  ].join("\r\n");
  const firstChineseByte = new TextEncoder().encode(body.slice(0, body.indexOf("你"))).length + 1;

  feedUtf8(parser, body, [5, firstChineseByte, firstChineseByte + 1, 91]);

  assert.deepEqual(events, [
    { type: "delta", content: "你" },
    { type: "delta", content: "好" },
    {
      type: "usage",
      promptTokens: 7,
      completionTokens: 2,
      totalTokens: 9,
      source: "provider",
    },
    { type: "done", finishReason: "stop" },
  ]);
});

test("a stream closed without a DONE sentinel still completes once", () => {
  const events = [];
  const parser = createOpenAIStreamParser((event) => events.push(event));
  parser.feed('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  parser.end();

  assert.deepEqual(events, [
    { type: "delta", content: "partial" },
    { type: "done", finishReason: null },
  ]);
});

test("tool calls and invalid JSON fail with explicit stream errors", () => {
  const toolParser = createOpenAIStreamParser(() => undefined);
  assert.throws(
    () => toolParser.feed('data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n'),
    (error) => error instanceof StreamProtocolError
      && error.code === "tool_calls_unsupported"
      && error.status === 422,
  );

  const invalidParser = createOpenAIStreamParser(() => undefined);
  assert.throws(
    () => invalidParser.feed("data: not-json\n\n"),
    (error) => error instanceof StreamProtocolError
      && error.code === "invalid_upstream_stream",
  );
});

test("the normalized site event protocol round-trips metadata, deltas, usage, and done", () => {
  const events = [];
  const parser = createChatEventParser((event) => events.push(event));
  parser.feed(encodeChatEvent("meta", { transport: "proxy", status: 200 }));
  parser.feed(encodeChatEvent("delta", { content: "hello" }));
  parser.feed(encodeChatEvent("usage", {
    promptTokens: 4,
    completionTokens: 1,
    totalTokens: 5,
    source: "provider",
  }));
  parser.feed(encodeChatEvent("done", { finishReason: "stop" }));
  parser.end();

  assert.deepEqual(events, [
    { type: "meta", transport: "proxy", status: 200 },
    { type: "delta", content: "hello" },
    {
      type: "usage",
      promptTokens: 4,
      completionTokens: 1,
      totalTokens: 5,
      source: "provider",
    },
    { type: "done", finishReason: "stop" },
  ]);
});

test("token usage accepts provider aliases without treating absent values as zero usage", () => {
  assert.deepEqual(normalizeTokenUsage({ input_tokens: 5, output_tokens: 3 }), {
    promptTokens: 5,
    completionTokens: 3,
    totalTokens: 8,
    source: "provider",
  });
  assert.equal(normalizeTokenUsage({ prompt_tokens: null, completion_tokens: null }), null);
});
