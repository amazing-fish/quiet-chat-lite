import assert from "node:assert/strict";
import test from "node:test";
import {
  BOTTOM_FOLLOW_THRESHOLD,
  PROMPT_ANCHOR_OFFSET,
  distanceFromBottom,
  hasIntentionalTouchMove,
  initialConversationScrollTop,
  isNearBottom,
  isScrollAwayKey,
  isScrollTowardOlderContent,
  isTouchTowardOlderContent,
  matchesProgrammaticScroll,
  promptAnchorScrollTop,
  shouldProcessMessageFollowEffect,
  shouldResumeFollowingAtBottom,
} from "../app/lib/scroll-follow.mjs";

test("short answers remain near the bottom without negative distance", () => {
  const metrics = { scrollHeight: 320, scrollTop: 0, clientHeight: 640 };
  assert.equal(distanceFromBottom(metrics), 0);
  assert.equal(isNearBottom(metrics), true);
});

test("long answers follow only inside the bottom threshold", () => {
  const metrics = { scrollHeight: 1600, scrollTop: 900, clientHeight: 640 };
  assert.equal(distanceFromBottom(metrics), 60);
  assert.equal(isNearBottom(metrics), true);
  assert.equal(
    isNearBottom({ ...metrics, scrollTop: 879 }, BOTTOM_FOLLOW_THRESHOLD),
    false,
  );
});

test("keyboard navigation that moves toward older messages pauses following", () => {
  for (const key of ["ArrowUp", "PageUp", "Home"]) assert.equal(isScrollAwayKey(key), true);
  for (const key of ["ArrowDown", "PageDown", "End", "Enter"]) assert.equal(isScrollAwayKey(key), false);
});

test("touch intent ignores jitter and detects a deliberate gesture in either direction", () => {
  assert.equal(hasIntentionalTouchMove(300, 296), false);
  assert.equal(hasIntentionalTouchMove(300, 284), true);
  assert.equal(hasIntentionalTouchMove(300, 318), true);
});

test("only a downward drag toward older content pauses following, like a negative wheel", () => {
  assert.equal(isTouchTowardOlderContent(300, 318), true);
  assert.equal(isTouchTowardOlderContent(300, 284), false);
  assert.equal(isTouchTowardOlderContent(300, 304), false);
});

test("the prompt anchor offset is applied once from a single source", () => {
  assert.equal(PROMPT_ANCHOR_OFFSET, 8);
  assert.equal(
    promptAnchorScrollTop({ scrollTop: 400, containerTop: 120, anchorTop: 520 }),
    792,
  );
  assert.equal(
    promptAnchorScrollTop({ scrollTop: 0, containerTop: 120, anchorTop: 120 }, 0),
    0,
  );
});

test("an explicit pause survives its own near-bottom scroll event", () => {
  assert.equal(shouldResumeFollowingAtBottom({
    previousScrollTop: 950,
    scrollTop: 930,
    scrollHeight: 1600,
    clientHeight: 640,
  }), false);
  assert.equal(shouldResumeFollowingAtBottom({
    previousScrollTop: 960,
    scrollTop: 960,
    scrollHeight: 1600,
    clientHeight: 640,
  }), false);
});

test("an explicit pause resumes only after scrolling forward to the actual bottom", () => {
  assert.equal(shouldResumeFollowingAtBottom({
    previousScrollTop: 900,
    scrollTop: 940,
    scrollHeight: 1600,
    clientHeight: 640,
  }), false);
  assert.equal(shouldResumeFollowingAtBottom({
    previousScrollTop: 940,
    scrollTop: 960,
    scrollHeight: 1600,
    clientHeight: 640,
  }), true);
});

test("only the exact programmatic target is suppressed", () => {
  assert.equal(matchesProgrammaticScroll(960, 960), true);
  assert.equal(matchesProgrammaticScroll(959.5, 960), true);
  assert.equal(matchesProgrammaticScroll(900, 960), false);
});

test("scrollbar movement toward older content is treated as user intent", () => {
  assert.equal(isScrollTowardOlderContent(960, 900), true);
  assert.equal(isScrollTowardOlderContent(960, 959.5), false);
  assert.equal(isScrollTowardOlderContent(900, 940), false);
});

test("unvisited conversations open at the bottom while saved zero remains valid", () => {
  const metrics = { scrollHeight: 1600, clientHeight: 640 };
  assert.equal(initialConversationScrollTop(metrics, undefined), 960);
  assert.equal(initialConversationScrollTop(metrics, 0), 0);
  assert.equal(initialConversationScrollTop(metrics, 900), 900);
  assert.equal(initialConversationScrollTop(metrics, 2000), 960);
});

test("the final message update follows independently of request pending state", () => {
  assert.equal(shouldProcessMessageFollowEffect({
    conversationChanged: false,
    messagesChanged: true,
    skipNextFollow: false,
  }), true);
  assert.equal(shouldProcessMessageFollowEffect({
    conversationChanged: false,
    messagesChanged: false,
    skipNextFollow: false,
  }), false);
  assert.equal(shouldProcessMessageFollowEffect({
    conversationChanged: true,
    messagesChanged: true,
    skipNextFollow: false,
  }), false);
  assert.equal(shouldProcessMessageFollowEffect({
    conversationChanged: false,
    messagesChanged: false,
    skipNextFollow: true,
  }), true);
});
