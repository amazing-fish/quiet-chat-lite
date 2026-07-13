import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatRequest,
  createConversation,
  hydrateLocalState,
  serializeLocalState,
} from "../app/lib/chat-state.mjs";

test("the next request uses the latest Base URL and Model", () => {
  const conversation = createConversation("配置测试", [
    { id: "m1", role: "user", content: "你好" },
  ]);
  const first = buildChatRequest(conversation, {
    baseUrl: "https://one.example/v1",
    model: "model-one",
    apiKey: "session-secret",
  });
  const second = buildChatRequest(conversation, {
    baseUrl: "https://two.example/api",
    model: "model-two",
    apiKey: "session-secret",
  });

  assert.equal(first.baseUrl, "https://one.example/v1");
  assert.equal(first.model, "model-one");
  assert.equal(second.baseUrl, "https://two.example/api");
  assert.equal(second.model, "model-two");
});

test("a multi-turn request includes the current conversation's complete model history", () => {
  const conversation = createConversation("多轮测试", [
    { id: "m1", role: "user", content: "第一问" },
    { id: "m2", role: "assistant", content: "第一答" },
    { id: "m3", role: "error", content: "一次网络错误" },
    { id: "m4", role: "user", content: "第二问" },
  ]);

  const request = buildChatRequest(conversation, {
    baseUrl: "https://api.example/v1",
    model: "chat-model",
    apiKey: "session-secret",
  });

  assert.deepEqual(request.messages, [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ]);
});

test("local persistence restores conversations, Base URL, and Model but never API Key", () => {
  const conversation = createConversation("持久化测试", [
    { id: "m1", role: "user", content: "保留我" },
  ]);
  const serialized = serializeLocalState({
    conversations: [conversation],
    activeConversationId: conversation.id,
    settings: {
      baseUrl: "https://api.example/v1",
      model: "chat-model",
      apiKey: "must-not-persist",
    },
  });

  assert.doesNotMatch(serialized, /must-not-persist|apiKey/);
  assert.deepEqual(hydrateLocalState(serialized), {
    conversations: [conversation],
    activeConversationId: conversation.id,
    settings: {
      baseUrl: "https://api.example/v1",
      model: "chat-model",
      apiKey: "",
    },
  });
});
