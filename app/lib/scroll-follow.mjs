export const BOTTOM_FOLLOW_THRESHOLD = 80;
export const BOTTOM_RESUME_THRESHOLD = 1;
export const TOUCH_SCROLL_THRESHOLD = 8;

export function distanceFromBottom({ scrollHeight, scrollTop, clientHeight }) {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function isNearBottom(metrics, threshold = BOTTOM_FOLLOW_THRESHOLD) {
  return distanceFromBottom(metrics) <= threshold;
}

export function shouldResumeFollowingAtBottom(
  { previousScrollTop, scrollTop, scrollHeight, clientHeight },
  threshold = BOTTOM_RESUME_THRESHOLD,
) {
  return Number.isFinite(previousScrollTop)
    && Number.isFinite(scrollTop)
    && scrollTop > previousScrollTop
    && distanceFromBottom({ scrollHeight, scrollTop, clientHeight }) <= threshold;
}

export function matchesProgrammaticScroll(scrollTop, targetTop, tolerance = 1) {
  return Number.isFinite(scrollTop)
    && Number.isFinite(targetTop)
    && Math.abs(scrollTop - targetTop) <= tolerance;
}

export function isScrollTowardOlderContent(previousScrollTop, scrollTop, tolerance = 1) {
  return Number.isFinite(previousScrollTop)
    && Number.isFinite(scrollTop)
    && scrollTop < previousScrollTop - tolerance;
}

export function isScrollAwayKey(key) {
  return key === "ArrowUp" || key === "PageUp" || key === "Home";
}

export function hasIntentionalTouchMove(startY, currentY, threshold = TOUCH_SCROLL_THRESHOLD) {
  return Number.isFinite(startY)
    && Number.isFinite(currentY)
    && Math.abs(currentY - startY) >= threshold;
}
