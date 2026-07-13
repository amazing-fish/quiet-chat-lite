# 轻量 AI 对话器设计

## 目标与边界

构建一个打开即用的单页 AI 对话器。它只支持 OpenAI-compatible Chat Completions 的非流式文本对话，不包含账号、数据库、工具调用、文件、联网搜索或 Agent 能力。

## 架构

- 浏览器端负责会话列表、消息历史、设置面板和本地持久化。
- `localStorage` 仅保存会话、`Base URL` 和 `Model`；`API Key` 只存在 React 内存状态中。
- `/api/chat` 是唯一服务端请求边界，接收当前设置和完整消息历史，验证目标后转发到上游 `/chat/completions`。
- 代理仅允许 HTTPS 公网目标；拒绝凭据 URL、localhost、本地/内网/保留 IP、内部域名，并通过公共 DNS 查询检查域名解析结果。上游跳转被禁用，请求超时为 30 秒。

## 数据流

1. 用户编辑 Base URL、Model 或 API Key；下一次点击发送时从当前内存状态读取最新值。
2. 用户消息先加入当前会话，再将该会话全部 `user`/`assistant` 消息发送给 `/api/chat`。
3. 成功响应追加为 assistant 消息；错误以独立错误状态显示，不写入模型消息历史。
4. 等待中的请求由 `AbortController` 管理，“停止等待”只取消当前请求，不删除用户消息。

## 错误与兼容

- 代理把无效目标、鉴权失败、限流、网络故障、超时、无效 JSON、缺少文本内容和工具调用分别映射为简短中文错误。
- 支持 `POST {baseUrl}/chat/completions`，或当 Base URL 已以 `/chat/completions` 结尾时直接使用。
- 请求体固定为 `{ model, messages, stream: false }`，响应读取 `choices[0].message.content` 字符串。

## 界面

采用克制的浅色工作台风格：深墨色侧栏、暖白消息画布、青绿色动作强调。桌面三段式布局；手机端会话列表和设置以覆盖层展开。无插画、无复杂动画，重点放在消息可读性、清晰状态和触控尺寸。

## 验证

- 纯逻辑测试验证配置即时生效、完整历史、持久化排除 API Key。
- 代理测试验证 HTTPS/公网约束、DNS 解析校验、超时、鉴权、网络错误、非标准响应和工具调用。
- 完整构建与服务端渲染测试验证 Site 产物可部署。
