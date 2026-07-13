import assert from "node:assert/strict";
import test from "node:test";

import { requestErrorMessage, responseErrorMessage } from "../app/lib/client-errors.mjs";

test("network and timeout failures are readable", () => {
  assert.equal(
    requestErrorMessage(new DOMException("aborted", "AbortError"), false),
    "请求超时，请稍后重试。",
  );
  assert.equal(
    requestErrorMessage(new TypeError("fetch failed"), false),
    "无法连接到模型服务。若 Base URL 可在浏览器打开，通常是该服务未允许跨域请求或拒绝了云端代理。",
  );
  assert.equal(
    requestErrorMessage(new DOMException("aborted", "AbortError"), true),
    "已停止等待。",
  );
});

test("authentication and non-standard responses are readable", () => {
  assert.equal(responseErrorMessage(401), "鉴权失败，请检查 API Key。");
  assert.equal(
    responseErrorMessage(403),
    "鉴权或模型权限不足，请检查 API Key 及聊天接口权限。",
  );
  assert.equal(responseErrorMessage(504), "上游模型响应超时，请稍后重试。");
  assert.equal(responseErrorMessage(502), "模型服务返回了无法识别的响应。");
});
