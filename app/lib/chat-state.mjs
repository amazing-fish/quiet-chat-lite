import { randomId } from "./id.mjs";

export const STORAGE_KEY = "quiet-chat:v1";

export function createConversation(title = "新对话", messages = []) {
  const now = new Date().toISOString();
  return {
    id: randomId(),
    title: title.trim() || "新对话",
    messages,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildChatRequest(conversation, settings) {
  return {
    baseUrl: settings.baseUrl.trim(),
    model: settings.model.trim(),
    apiKey: settings.apiKey,
    messages: conversation.messages
      .filter(
        (message) =>
          (message.role === "user" || message.role === "assistant")
          && typeof message.content === "string"
          && Boolean(message.content.trim()),
      )
      .map(({ role, content }) => ({ role, content })),
  };
}

function withoutEmptyAssistantPlaceholders(conversations) {
  return conversations.map((conversation) => ({
    ...conversation,
    messages: Array.isArray(conversation.messages)
      ? conversation.messages.filter(
        (message) =>
          message?.role !== "assistant"
          || (typeof message.content === "string" && Boolean(message.content.trim())),
      )
      : [],
  }));
}

export function serializeLocalState(state) {
  return JSON.stringify({
    conversations: withoutEmptyAssistantPlaceholders(state.conversations),
    activeConversationId: state.activeConversationId,
    settings: {
      baseUrl: state.settings.baseUrl,
      model: state.settings.model,
    },
  });
}

export function hydrateLocalState(serialized) {
  const parsed = JSON.parse(serialized);
  const conversations = Array.isArray(parsed.conversations)
    ? withoutEmptyAssistantPlaceholders(parsed.conversations)
    : [];
  const activeConversationId = conversations.some(
    (conversation) => conversation.id === parsed.activeConversationId,
  )
    ? parsed.activeConversationId
    : conversations[0]?.id ?? null;

  return {
    conversations,
    activeConversationId,
    settings: {
      baseUrl:
        typeof parsed.settings?.baseUrl === "string"
          ? parsed.settings.baseUrl
          : "",
      model:
        typeof parsed.settings?.model === "string" ? parsed.settings.model : "",
      apiKey: "",
    },
  };
}
