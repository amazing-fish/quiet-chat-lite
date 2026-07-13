# Lightweight AI Chat Site Implementation Plan

> **For AI:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and deploy a lightweight single-page OpenAI-compatible chat client with browser-local conversations and a secure Site proxy.

**Architecture:** A client-side React workspace owns conversations, settings, and local persistence. A single Next route delegates validation and upstream handling to a testable proxy module that fails closed for unsafe destinations and normalizes upstream errors.

**Tech Stack:** vinext, React 19, TypeScript, Node test runner, Cloudflare Workers-compatible fetch.

---

### Task 1: Define client contracts with failing tests

**Files:**
- Create: `tests/chat-state.test.mjs`
- Create: `tests/client-errors.test.mjs`
- Create: `app/lib/chat-state.mjs`
- Create: `app/lib/client-errors.mjs`

1. Write tests for current-settings request construction, full message history, local persistence without API Key, and readable client errors.
2. Run `node --test tests/chat-state.test.mjs tests/client-errors.test.mjs` and confirm missing-module failure.
3. Implement the smallest pure modules that satisfy the contracts.
4. Re-run the tests and confirm they pass.

### Task 2: Define the proxy boundary with failing tests

**Files:**
- Create: `tests/proxy.test.mjs`
- Create: `app/lib/proxy.mjs`
- Create: `app/api/chat/route.ts`

1. Write tests for HTTPS-only public targets, private IP and internal hostname rejection, DNS resolution checks, updated request forwarding, timeouts, authentication failures, network errors, non-standard responses, and tool calls.
2. Run `node --test tests/proxy.test.mjs` and confirm missing-module failure.
3. Implement URL validation, DNS checks, timeout, upstream response normalization, and the route adapter.
4. Re-run the proxy tests and confirm they pass.

### Task 3: Build the responsive chat workspace

**Files:**
- Replace: `app/page.tsx`
- Replace: `app/globals.css`
- Modify: `app/layout.tsx`
- Delete: `app/_sites-preview/SkeletonPreview.tsx`
- Delete: `app/_sites-preview/preview.css`
- Modify: `package.json`
- Modify: `package-lock.json`

1. Add a source-level UI contract test for accessible controls and the absence of persistent API Key storage.
2. Run it and confirm the starter fails the contract.
3. Implement conversation CRUD, settings, send/abort behavior, status rendering, local clearing, and responsive panels.
4. Remove starter-only preview code and dependency.
5. Re-run all logic and UI contract tests.

### Task 4: Validate and publish

**Files:**
- Modify: `tests/rendered-html.test.mjs`
- Modify: `.openai/hosting.json`

1. Replace starter rendering assertions with product rendering assertions.
2. Run the full test suite, lint, and production build; fix actual failures.
3. Create the Site, persist its project ID, commit and push the validated source, package the exact build, save a version, and deploy privately.
4. Poll deployment status to success and return the production URL.
