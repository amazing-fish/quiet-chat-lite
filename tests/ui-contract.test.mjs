import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const cssUrl = new URL("../app/globals.css", import.meta.url);

test("chat workspace exposes the required conversation and request controls", async () => {
  const page = await readFile(pageUrl, "utf8");
  assert.match(page, /新建对话/);
  assert.match(page, /重命名/);
  assert.match(page, /删除对话/);
  assert.match(page, /清空本地数据/);
  assert.match(page, /停止等待/);
  assert.match(page, /发送消息/);
  assert.match(page, /Base URL/);
  assert.match(page, /API Key/);
  assert.match(page, /请求控制台/);
  assert.match(page, /复制完整记录/);
  assert.match(page, /API Key 始终隐藏/);
  assert.match(page, /Original response/);
  assert.match(page, /Raw body/);
  assert.match(page, /切换到黑夜模式/);
  assert.match(page, /THEME_STORAGE_KEY/);
  assert.match(page, /trace\.state === "error"/);
  assert.match(page, /requestChatStreamWithFallback/);
  assert.match(page, /模型正在生成/);
  assert.match(page, /Provider Token Usage/);
  assert.match(page, /流式响应/);
  assert.doesNotMatch(page, /非流式响应/);
});

test("API Key remains memory-only while allowed local state is persisted", async () => {
  const page = await readFile(pageUrl, "utf8");
  assert.match(page, /localStorage\.setItem\(STORAGE_KEY, serializeLocalState/);
  assert.doesNotMatch(page, /sessionStorage/);
  assert.doesNotMatch(page, /localStorage\.(?:setItem|getItem)[^\n]*apiKey/i);
});

test("responsive styles provide mobile panels and accessible reduced motion", async () => {
  const css = await readFile(cssUrl, "utf8");
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.sidebar\.is-open/);
  assert.match(css, /\.settings-panel\.is-open/);
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /\.message-usage/);
  assert.match(css, /\.trace-state\.is-streaming/);
});
