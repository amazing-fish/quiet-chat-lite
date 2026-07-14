const CHAT_EVENT_TYPES = new Set(["meta", "delta", "usage", "done", "error"]);

export class StreamProtocolError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "StreamProtocolError";
    this.code = code;
    this.status = status;
  }
}

export function encodeChatEvent(type, data = {}) {
  if (!CHAT_EVENT_TYPES.has(type)) {
    throw new StreamProtocolError("invalid_stream_event", `Unsupported stream event: ${type}`);
  }
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseParser(onEvent) {
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  function dispatch() {
    if (dataLines.length > 0) {
      onEvent({ event: eventName, data: dataLines.join("\n") });
    }
    eventName = "message";
    dataLines = [];
  }

  function processLine(line) {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value || "message";
    if (field === "data") dataLines.push(value);
  }

  return {
    feed(chunk) {
      buffer += chunk;
      let lineEnd;
      while ((lineEnd = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        processLine(line);
      }
    },
    end() {
      if (buffer) processLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      buffer = "";
      dispatch();
    },
  };
}

export function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens);
  const explicitTotal = Number(usage.total_tokens);
  const hasPrompt = Number.isFinite(promptTokens) && promptTokens >= 0;
  const hasCompletion = Number.isFinite(completionTokens) && completionTokens >= 0;
  const hasTotal = Number.isFinite(explicitTotal) && explicitTotal >= 0;
  if (!hasPrompt && !hasCompletion && !hasTotal) return null;
  const prompt = hasPrompt ? promptTokens : 0;
  const completion = hasCompletion ? completionTokens : 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: hasTotal ? explicitTotal : prompt + completion,
    source: "provider",
  };
}

export function createOpenAIStreamParser(onEvent) {
  let completed = false;
  let finishReason = null;

  function emitDone() {
    if (completed) return;
    completed = true;
    onEvent({ type: "done", finishReason });
  }

  const parser = createSseParser(({ data }) => {
    if (completed) return;
    if (data.trim() === "[DONE]") {
      emitDone();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new StreamProtocolError(
        "invalid_upstream_stream",
        "模型服务返回了无法解析的流式事件。",
      );
    }

    if (payload?.error) {
      throw new StreamProtocolError(
        "upstream_stream_error",
        typeof payload.error.message === "string"
          ? payload.error.message.slice(0, 240)
          : "模型服务在生成过程中返回错误。",
      );
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const delta = choice?.delta;
    if (delta?.tool_calls || delta?.function_call) {
      throw new StreamProtocolError(
        "tool_calls_unsupported",
        "当前版本不支持工具调用响应。",
        422,
      );
    }
    if (typeof delta?.content === "string" && delta.content) {
      onEvent({ type: "delta", content: delta.content });
    }
    if (typeof choice?.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }

    const usage = normalizeTokenUsage(payload?.usage);
    if (usage) onEvent({ type: "usage", ...usage });
  });

  return {
    feed(chunk) {
      parser.feed(chunk);
    },
    end() {
      parser.end();
      emitDone();
    },
  };
}

export function createChatEventParser(onEvent) {
  return createSseParser(({ event, data }) => {
    if (!CHAT_EVENT_TYPES.has(event)) return;
    let payload;
    try {
      payload = data ? JSON.parse(data) : {};
    } catch {
      throw new StreamProtocolError(
        "invalid_stream_event",
        "站点返回了无法解析的流式事件。",
      );
    }
    onEvent({ type: event, ...payload });
  });
}

export function isEventStream(headers) {
  return /^text\/event-stream\b/i.test(headers.get("content-type") ?? "");
}
