"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  STORAGE_KEY,
  buildChatRequest,
  createConversation,
  hydrateLocalState,
  serializeLocalState,
} from "./lib/chat-state.mjs";
import { requestErrorMessage } from "./lib/client-errors.mjs";
import { requestChatStreamWithFallback } from "./lib/chat-request.mjs";
import { randomId } from "./lib/id.mjs";

type MessageRole = "user" | "assistant" | "error";

type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: "provider";
};

type Message = {
  id: string;
  role: MessageRole;
  content: string;
  usage?: TokenUsage;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
};

type Settings = {
  baseUrl: string;
  model: string;
  apiKey: string;
};
type Account = { email: string; name: string };
type Theme = "light" | "dark";

type RequestTrace = {
  id: string;
  requestId: string;
  startedAt: string;
  transport: "proxy" | "direct";
  method: string;
  url: string;
  targetUrl: string;
  state: "pending" | "streaming" | "success" | "stopped" | "error";
  durationMs: number;
  status: number | null;
  request: unknown;
  response: unknown;
  error?: string;
};

type UpstreamResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

function upstreamResponseFrom(trace: RequestTrace | null): UpstreamResponse | null {
  if (!trace || !trace.response || typeof trace.response !== "object") return null;
  const candidate = (trace.response as { upstreamResponse?: unknown }).upstreamResponse;
  if (!candidate || typeof candidate !== "object") return null;
  const response = candidate as Partial<UpstreamResponse>;
  if (typeof response.status !== "number" || typeof response.body !== "string") return null;
  return {
    status: response.status,
    statusText: typeof response.statusText === "string" ? response.statusText : "",
    headers: response.headers && typeof response.headers === "object"
      ? response.headers as Record<string, string>
      : {},
    body: response.body,
  };
}

const DEFAULT_SETTINGS: Settings = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKey: "",
};
const THEME_STORAGE_KEY = "quiet-chat:theme";

function messageId() {
  return randomId();
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [requestTraces, setRequestTraces] = useState<RequestTrace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("light");
  const abortRef = useRef<AbortController | null>(null);
  const stoppedByUserRef = useRef(false);
  const lastErrorTraceIdRef = useRef<string | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [activeConversationId, conversations],
  );

  useEffect(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    const initialTheme: Theme = savedTheme === "light" || savedTheme === "dark"
      ? savedTheme
      : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = initialTheme;
    const timer = window.setTimeout(() => setTheme(initialTheme), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          const restored = hydrateLocalState(saved);
          if (restored.conversations.length > 0) {
            setConversations(restored.conversations);
            setActiveConversationId(restored.activeConversationId);
            setSettings(restored.settings);
          } else {
            const conversation = createConversation();
            setConversations([conversation]);
            setActiveConversationId(conversation.id);
            setSettings({ ...DEFAULT_SETTINGS, ...restored.settings });
          }
        } catch {
          const conversation = createConversation();
          setConversations([conversation]);
          setActiveConversationId(conversation.id);
        }
      } else {
        const conversation = createConversation();
        setConversations([conversation]);
        setActiveConversationId(conversation.id);
      }
      setHydrated(true);
      fetch("/api/profile", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { user: Account | null; profile?: Settings };
        setAccount(data.user);
        if (data.profile) setSettings(data.profile);
      }).catch(() => undefined);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated || conversations.length === 0) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, serializeLocalState({
        conversations,
        activeConversationId,
        settings,
      }));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [activeConversationId, conversations, hydrated, settings]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({
      behavior: pendingConversationId ? "auto" : "smooth",
      block: "end",
    });
  }, [activeConversation?.messages, pendingConversationId]);

  function updateConversation(id: string, updater: (conversation: Conversation) => Conversation) {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === id ? updater(conversation) : conversation)),
    );
  }

  function newConversation() {
    const conversation = createConversation() as Conversation;
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setDraft("");
    setSidebarOpen(false);
  }

  function renameConversation(conversation: Conversation) {
    const title = window.prompt("为这个对话输入新名称", conversation.title)?.trim();
    if (!title) return;
    updateConversation(conversation.id, (current) => ({
      ...current,
      title: title.slice(0, 60),
      updatedAt: new Date().toISOString(),
    }));
  }

  function deleteConversation(id: string) {
    if (!window.confirm("删除这个对话？此操作只影响当前设备。")) return;
    setConversations((current) => {
      const remaining = current.filter((conversation) => conversation.id !== id);
      if (remaining.length > 0) {
        if (activeConversationId === id) setActiveConversationId(remaining[0].id);
        return remaining;
      }
      const replacement = createConversation() as Conversation;
      setActiveConversationId(replacement.id);
      return [replacement];
    });
  }

  function clearLocalData() {
    if (!window.confirm("清空本机保存的全部对话和连接设置？")) return;
    stoppedByUserRef.current = true;
    abortRef.current?.abort();
    localStorage.removeItem(STORAGE_KEY);
    const conversation = createConversation() as Conversation;
    setConversations([conversation]);
    setActiveConversationId(conversation.id);
    setSettings(DEFAULT_SETTINGS);
    setDraft("");
    setSettingsError("");
    setPendingConversationId(null);
    setSettingsOpen(false);
  }

  function validateSettings() {
    const missing = [
      !settings.baseUrl.trim() && "Base URL",
      !settings.model.trim() && "Model",
      !settings.apiKey.trim() && "API Key",
    ].filter(Boolean);
    if (missing.length > 0) {
      setSettingsError(`请填写 ${missing.join("、")}。`);
      setSettingsOpen(true);
      return false;
    }
    setSettingsError("");
    return true;
  }

  async function saveSettings() {
    if (!validateSettings()) return;
    if (!account) { window.location.href = "/signin-with-chatgpt?return_to=%2F"; return; }
    setSavingSettings(true);
    try {
      const response = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "保存失败");
      setSettingsOpen(false);
    } catch (error) { setSettingsError(error instanceof Error ? error.message : "保存失败"); }
    finally { setSavingSettings(false); }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || pendingConversationId || !activeConversation) return;
    if (!validateSettings()) return;

    const userMessage: Message = { id: messageId(), role: "user", content };
    const targetId = activeConversation.id;
    const requestConversation: Conversation = {
      ...activeConversation,
      title:
        activeConversation.messages.length === 0 && activeConversation.title === "新对话"
          ? content.replace(/\s+/g, " ").slice(0, 28)
          : activeConversation.title,
      messages: [...activeConversation.messages, userMessage],
      updatedAt: new Date().toISOString(),
    };
    const assistantMessageId = messageId();
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
    };
    updateConversation(targetId, () => ({
      ...requestConversation,
      messages: [...requestConversation.messages, assistantMessage],
    }));
    setDraft("");
    setPendingConversationId(targetId);
    stoppedByUserRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = messageId();
    lastErrorTraceIdRef.current = null;
    let streamedContent = "";
    let frameId: number | null = null;

    const updateAssistant = (content: string, usage?: TokenUsage) => {
      updateConversation(targetId, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content, ...(usage ? { usage } : {}) }
            : message,
        ),
        updatedAt: new Date().toISOString(),
      }));
    };

    const flushStreamedContent = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = null;
      updateAssistant(streamedContent);
    };

    const removeEmptyAssistant = () => {
      updateConversation(targetId, (conversation) => ({
        ...conversation,
        messages: conversation.messages.filter(
          (message) => message.id !== assistantMessageId || Boolean(message.content),
        ),
        updatedAt: new Date().toISOString(),
      }));
    };

    const recordTrace = (trace: RequestTrace) => {
      setRequestTraces((current) => {
        const index = current.findIndex((item) => item.id === trace.id);
        if (index === -1) return [trace, ...current].slice(0, 50);
        return current.map((item) => (item.id === trace.id ? trace : item));
      });
      setSelectedTraceId(trace.id);
      if (trace.state === "error") lastErrorTraceIdRef.current = trace.id;
    };

    try {
      const result = await requestChatStreamWithFallback(
        buildChatRequest(requestConversation, settings),
        {
          signal: controller.signal,
          requestId,
          onTrace: recordTrace,
          onDelta: (_delta: string, accumulated: string) => {
            streamedContent = accumulated;
            if (frameId === null) {
              frameId = window.requestAnimationFrame(() => {
                frameId = null;
                updateAssistant(streamedContent);
              });
            }
          },
          onUsage: (usage: TokenUsage) => updateAssistant(streamedContent, usage),
        },
      );
      streamedContent = result.content as string;
      flushStreamedContent();
      if (result.usage) updateAssistant(streamedContent, result.usage as TokenUsage);
    } catch (error) {
      flushStreamedContent();
      const wasStopped = stoppedByUserRef.current && controller.signal.aborted;
      if (wasStopped) {
        removeEmptyAssistant();
        return;
      }
      removeEmptyAssistant();
      const errorContent = error instanceof Error && error.name !== "AbortError"
        ? error.message
        : requestErrorMessage(error, false);
      updateConversation(targetId, (conversation) => ({
        ...conversation,
        messages: [
          ...conversation.messages,
          { id: messageId(), role: "error", content: errorContent },
        ],
        updatedAt: new Date().toISOString(),
      }));
      if (lastErrorTraceIdRef.current) {
        setSelectedTraceId(lastErrorTraceIdRef.current);
      }
      setConsoleOpen(true);
    } finally {
      abortRef.current = null;
      setPendingConversationId(null);
    }
  }

  function stopWaiting() {
    stoppedByUserRef.current = true;
    abortRef.current?.abort();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const settingsReady = Boolean(
    settings.baseUrl.trim() && settings.model.trim() && settings.apiKey.trim(),
  );
  const isActivePending = Boolean(
    pendingConversationId && pendingConversationId === activeConversationId,
  );
  const selectedTrace = requestTraces.find((trace) => trace.id === selectedTraceId)
    ?? requestTraces[0]
    ?? null;
  const selectedUpstreamResponse = upstreamResponseFrom(selectedTrace);

  async function copyTrace() {
    if (!selectedTrace) return;
    await navigator.clipboard.writeText(JSON.stringify(selectedTrace, null, 2));
  }

  function toggleTheme() {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="历史对话">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">Q</div>
          <div>
            <strong>Quiet Chat</strong>
            <span>本地对话工作台</span>
          </div>
          <button className="icon-button close-mobile" onClick={() => setSidebarOpen(false)} aria-label="关闭历史对话">×</button>
        </div>

        <button className="new-chat-button" onClick={newConversation}>＋ 新建对话</button>

        <div className="conversation-list">
          {conversations.map((conversation) => (
            <article
              key={conversation.id}
              className={`conversation-card ${conversation.id === activeConversationId ? "is-active" : ""}`}
            >
              <button
                className="conversation-select"
                onClick={() => {
                  setActiveConversationId(conversation.id);
                  setSidebarOpen(false);
                }}
              >
                <strong>{conversation.title}</strong>
                <span>{conversation.messages.length} 条消息</span>
              </button>
              <div className="conversation-actions">
                <button onClick={() => renameConversation(conversation)} aria-label={`重命名 ${conversation.title}`}>重命名</button>
                <button onClick={() => deleteConversation(conversation.id)} aria-label={`删除对话 ${conversation.title}`}>删除</button>
              </div>
            </article>
          ))}
        </div>

        <div className="sidebar-footer">
          <p>对话保存在本机，个人配置登录后云端同步</p>
          <button onClick={clearLocalData}>清空本地数据</button>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开历史对话">☰</button>
          <div className="conversation-heading">
            <span>当前对话</span>
            <h1>{activeConversation?.title ?? "正在载入"}</h1>
          </div>
          <button
            className="theme-button"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "切换到日间模式" : "切换到黑夜模式"}
            title={theme === "dark" ? "切换到日间模式" : "切换到黑夜模式"}
          >
            <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
          </button>
          <button className="console-button" onClick={() => setConsoleOpen(true)}>
            请求控制台
            {requestTraces.length > 0 && <span>{requestTraces.length}</span>}
          </button>
          <button className="settings-button" onClick={() => setSettingsOpen(true)}>
            <span className={`connection-dot ${settingsReady ? "is-ready" : ""}`} />
            模型设置
          </button>
          {account ? <a className="account-button" href="/signout-with-chatgpt?return_to=%2F" title="退出登录">{account.name}</a> : <a className="account-button" href="/signin-with-chatgpt?return_to=%2F">登录</a>}
        </header>

        <div className="message-scroll" aria-live="polite">
          {activeConversation && activeConversation.messages.length === 0 ? (
            <div className="empty-state">
              <span className="eyebrow">READY WHEN YOU ARE</span>
              <h2>从一句话开始。</h2>
              <p>填写模型连接后，在这里进行简单、连续的多轮对话。</p>
              {!settingsReady && <button onClick={() => setSettingsOpen(true)}>完成模型连接设置</button>}
            </div>
          ) : (
            <div className="messages">
              {activeConversation?.messages.map((message) => (
                <article key={message.id} className={`message message-${message.role}`}>
                  <div className="message-label">
                    {message.role === "user" ? "你" : message.role === "assistant" ? "模型" : "错误"}
                  </div>
                  <div className="message-content">
                    <div className="message-text">{message.content}</div>
                    {message.role === "assistant" && message.usage && (
                      <div className="message-usage" aria-label="Provider Token Usage">
                        <span>Provider usage</span>
                        <b>输入 {message.usage.promptTokens}</b>
                        <b>输出 {message.usage.completionTokens}</b>
                        <b>合计 {message.usage.totalTokens} tokens</b>
                      </div>
                    )}
                  </div>
                </article>
              ))}
              {isActivePending && (
                <div className="waiting-row" role="status">
                  <span /><span /><span />
                  <b>模型正在生成</b>
                </div>
              )}
              <div ref={messageEndRef} />
            </div>
          )}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <div className="composer-box">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={settingsReady ? "输入消息，Enter 发送，Shift + Enter 换行" : "请先完成模型连接设置"}
              aria-label="消息内容"
              rows={1}
              disabled={!activeConversation || isActivePending}
            />
            {isActivePending ? (
              <button type="button" className="stop-button" onClick={stopWaiting}>停止等待</button>
            ) : (
              <button type="submit" className="send-button" disabled={!draft.trim() || !activeConversation} aria-label="发送消息">发送</button>
            )}
          </div>
          <p>流式响应 · Token 数来自模型服务 · 当前会话完整历史会发送给模型</p>
        </form>
      </section>

      <button
        className={`panel-backdrop ${sidebarOpen || settingsOpen ? "is-visible" : ""}`}
        onClick={() => { setSidebarOpen(false); setSettingsOpen(false); }}
        aria-label="关闭面板"
      />

      <aside className={`settings-panel ${settingsOpen ? "is-open" : ""}`} aria-label="模型连接设置">
        <div className="settings-heading">
          <div>
            <span>CONNECTION</span>
            <h2>模型连接</h2>
          </div>
          <button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭模型设置">×</button>
        </div>
        <p className="settings-intro">修改后会从下一次请求开始生效。</p>
        {settingsError && <div className="settings-error" role="alert">{settingsError}</div>}
        <label>
          <span>Base URL</span>
          <input
            type="url"
            value={settings.baseUrl}
            onChange={(event) => setSettings((current) => ({ ...current, baseUrl: event.target.value }))}
            placeholder="https://api.example.com/v1"
            autoComplete="url"
          />
          <small>仅支持可公开访问的 HTTPS 地址</small>
        </label>
        <label>
          <span>Model</span>
          <input
            value={settings.model}
            onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))}
            placeholder="model-name"
            autoComplete="off"
          />
        </label>
        <label>
          <span>API Key</span>
          <input
            type="password"
            value={settings.apiKey}
            onChange={(event) => setSettings((current) => ({ ...current, apiKey: event.target.value }))}
            placeholder="登录后加密保存在个人配置中"
            autoComplete="off"
            spellCheck={false}
          />
          <small>登录后经 AES-GCM 加密保存，换设备也可自动读取</small>
        </label>
        <div className="security-note">
          <strong>安全边界</strong>
          <p>请求通过 Site 代理转发；代理不记录密钥或消息正文，并拒绝本地、内网及非 HTTPS 目标。</p>
        </div>
        <button
          className="save-settings"
          onClick={() => void saveSettings()}
          disabled={savingSettings}
        >
          {savingSettings ? "正在保存…" : account ? "保存到个人配置" : "登录并保存配置"}
        </button>
      </aside>

      <aside className={`request-console ${consoleOpen ? "is-open" : ""}`} aria-label="请求控制台">
        <div className="console-heading">
          <div>
            <span>NETWORK INSPECTOR</span>
            <h2>请求控制台</h2>
          </div>
          <div className="console-heading-actions">
            <button
              onClick={() => {
                setRequestTraces([]);
                setSelectedTraceId(null);
              }}
              disabled={requestTraces.length === 0}
            >清空</button>
            <button className="icon-button" onClick={() => setConsoleOpen(false)} aria-label="关闭请求控制台">×</button>
          </div>
        </div>

        {requestTraces.length === 0 ? (
          <div className="console-empty">
            <strong>还没有请求记录</strong>
            <p>发送一条消息后，这里会显示请求参数、响应状态、响应正文与耗时。API Key 始终隐藏。</p>
          </div>
        ) : (
          <div className="console-body">
            <nav className="trace-list" aria-label="请求记录">
              {requestTraces.map((trace) => (
                <button
                  key={trace.id}
                  className={trace.id === selectedTrace?.id ? "is-selected" : ""}
                  onClick={() => setSelectedTraceId(trace.id)}
                >
                  <span className={`trace-state is-${trace.state}`} />
                  <span className="trace-main">
                    <strong>{trace.transport === "proxy" ? "站点代理" : "浏览器直连"}</strong>
                    <small>{trace.method} {trace.url}</small>
                  </span>
                  <span className="trace-meta">
                    <b>{trace.status ?? (["pending", "streaming"].includes(trace.state) ? "…" : trace.state === "stopped" ? "STOP" : "ERR")}</b>
                    <small>{trace.durationMs} ms</small>
                  </span>
                </button>
              ))}
            </nav>

            {selectedTrace && (
              <section className="trace-detail">
                <div className="trace-summary">
                  <div><span>状态</span><strong>{selectedUpstreamResponse?.status ?? selectedTrace.status ?? selectedTrace.state}</strong></div>
                  <div><span>耗时</span><strong>{selectedTrace.durationMs} ms</strong></div>
                  <div><span>通道</span><strong>{selectedTrace.transport === "proxy" ? "Site 代理" : "浏览器直连"}</strong></div>
                  <div><span>时间</span><strong>{new Date(selectedTrace.startedAt).toLocaleTimeString()}</strong></div>
                  <button onClick={() => void copyTrace()}>复制完整记录</button>
                </div>
                <div className="trace-url"><b>{selectedTrace.method}</b><code>{selectedTrace.url}</code></div>
                {selectedTrace.targetUrl !== selectedTrace.url && (
                  <div className="trace-target"><span>上游目标</span><code>{selectedTrace.targetUrl}</code></div>
                )}
                <div className="trace-payloads">
                  <article>
                    <h3>Request</h3>
                    <pre>{JSON.stringify(selectedTrace.request, null, 2)}</pre>
                  </article>
                  <article>
                    <h3>Original response</h3>
                    {selectedUpstreamResponse ? (
                      <>
                        <div className="response-status-line">
                          HTTP {selectedUpstreamResponse.status}{selectedUpstreamResponse.statusText ? ` ${selectedUpstreamResponse.statusText}` : ""}
                        </div>
                        <h4>Headers <small>Set-Cookie 已隐藏</small></h4>
                        <pre className="response-headers">{JSON.stringify(selectedUpstreamResponse.headers, null, 2)}</pre>
                        <h4>Raw body</h4>
                        <pre>{selectedUpstreamResponse.body || "(empty body)"}</pre>
                      </>
                    ) : (
                      <pre>{JSON.stringify(selectedTrace.error ? { error: selectedTrace.error, response: selectedTrace.response } : selectedTrace.response, null, 2)}</pre>
                    )}
                  </article>
                </div>
              </section>
            )}
          </div>
        )}
      </aside>
    </main>
  );
}
