import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const cssUrl = new URL("../app/globals.css", import.meta.url);
const buildMetadataTypesUrl = new URL("../app/build-metadata.d.ts", import.meta.url);
const markdownMessageUrl = new URL("../app/markdown-message.tsx", import.meta.url);
const markdownRendererUrl = new URL("../app/lib/markdown-render.mjs", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const viteConfigUrl = new URL("../vite.config.ts", import.meta.url);

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
  assert.match(page, /readResponseErrorMessage/);
  assert.doesNotMatch(page, /const data = await response\.json\(\) as \{ error\?: string \}/);
  assert.match(page, /模型正在生成/);
  assert.match(page, /Provider Token Usage/);
  assert.match(page, /流式响应/);
  assert.match(page, /message\.role === "assistant"[\s\S]*?<MarkdownMessage markdown=\{message\.content\}/);
  assert.match(page, /: <div className="message-text">\{message\.content\}<\/div>/);
  assert.match(page, /返回最新 · 继续跟随/);
  assert.match(page, /onWheel=\{handleMessageWheel\}/);
  assert.match(page, /onTouchMove=\{handleMessageTouchMove\}/);
  assert.match(page, /onKeyDown=\{handleMessageKeyDown\}/);
  assert.match(page, /data-scroll-anchor/);
  assert.match(page, /skipNextStreamFollowRef/);
  assert.match(page, /behavior: "auto"/);
  assert.doesNotMatch(page, /messageEndRef\.current\?\.scrollIntoView/);
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
  assert.match(css, /\.scroll-follow-control/);
  assert.match(css, /\.markdown-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.markdown-message td\s*\{[^}]*min-width:\s*8\.5em/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[\s\S]*?\.markdown-message th,\s*\.markdown-message td\s*\{[^}]*min-width:\s*4\.5em/,
  );
  assert.match(css, /\.markdown-code-block pre\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.markdown-code-header button/);
  assert.match(css, /--syntax-keyword/);
});

test("site footer exposes the package version and build update time", async () => {
  const [page, css, buildMetadataTypes, packageSource, viteConfig] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(cssUrl, "utf8"),
    readFile(buildMetadataTypesUrl, "utf8"),
    readFile(packageUrl, "utf8"),
    readFile(viteConfigUrl, "utf8"),
  ]);
  const packageMetadata = JSON.parse(packageSource);

  assert.match(packageMetadata.version, /^\d+\.\d+\.\d+$/);
  assert.match(viteConfig, /import packageMetadata from "\.\/package\.json"/);
  assert.match(viteConfig, /__APP_VERSION__:\s*JSON\.stringify\(packageMetadata\.version\)/);
  assert.match(viteConfig, /__APP_UPDATED_AT__:\s*JSON\.stringify\(buildUpdatedAt\)/);
  assert.match(buildMetadataTypes, /declare const __APP_VERSION__: string/);
  assert.match(buildMetadataTypes, /declare const __APP_UPDATED_AT__: string/);
  assert.match(page, /timeZone:\s*"Asia\/Shanghai"/);
  assert.match(page, /className="site-release"/);
  assert.match(page, /v\{__APP_VERSION__\}/);
  assert.match(page, /<time dateTime=\{__APP_UPDATED_AT__\}>更新时间 \{APP_UPDATED_AT_LABEL\}<\/time>/);
  assert.match(css, /\.site-release\s*\{/);
});

test("assistant Markdown maps a pure safe structure to JSX without HTML injection", async () => {
  const [component, renderer] = await Promise.all([
    readFile(markdownMessageUrl, "utf8"),
    readFile(markdownRendererUrl, "utf8"),
  ]);

  assert.match(component, /markdownToRenderTree\(markdown\)/);
  assert.match(component, /target=\{node\.external \? "_blank"/);
  assert.match(component, /rel=\{node\.external \? "noopener noreferrer"/);
  assert.match(component, /const copyState = copyResult\?\.value === node\.value \? copyResult\.state : "idle"/);
  assert.match(component, /const valueToCopy = node\.value/);
  assert.match(component, /navigator\.clipboard\.writeText\(valueToCopy\)/);
  assert.match(component, /setCopyResult\(\{ value: valueToCopy, state: "copied" \}\)/);
  assert.match(component, /const copyResetTimerRef = useRef<number \| null>\(null\)/);
  assert.match(component, /window\.clearTimeout\(copyResetTimerRef\.current\)/);
  assert.match(component, /window\.setTimeout\([\s\S]*?COPY_FEEDBACK_DURATION_MS/);
  assert.match(component, /const COPY_FEEDBACK_DURATION_MS = 2_000/);
  assert.match(component, /return \(\) => \{[\s\S]*?window\.clearTimeout\(copyResetTimerRef\.current\)/);
  assert.match(component, /aria-label=\{copyLabel\}/);
  assert.doesNotMatch(component, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(renderer, /PLACEHOLDER_BASE/);
  assert.match(renderer, /const compact = value\.replace/);
  assert.match(renderer, /new URL\(compact\)/);
  assert.match(renderer, /compact\.includes/);
  assert.doesNotMatch(renderer, /(?:from|require\()["']react/);
  assert.doesNotMatch(renderer, /\b(?:window|document)\s*\./);
  assert.doesNotMatch(renderer, /dangerouslySetInnerHTML/);
});
