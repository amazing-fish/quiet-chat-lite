import assert from "node:assert/strict";
import test from "node:test";
import {
  BOTTOM_FOLLOW_THRESHOLD,
  distanceFromBottom,
  hasIntentionalTouchMove,
  isNearBottom,
  isScrollAwayKey,
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
