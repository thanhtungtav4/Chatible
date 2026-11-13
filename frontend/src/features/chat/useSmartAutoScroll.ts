import { useCallback, useEffect, useRef, useState } from 'react';

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 96;

/**
 * Returns true when the scroll viewport is at or near the bottom of the message list.
 */
export function isScrolledNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx: number = AUTO_SCROLL_BOTTOM_THRESHOLD_PX
): boolean {
  if (scrollHeight <= 0 || clientHeight <= 0) return true;
  return scrollHeight - (scrollTop + clientHeight) <= thresholdPx;
}

export interface AutoScrollDecision {
  shouldScroll: boolean;
  behavior: ScrollBehavior;
  nextUnreadCount: number;
}

/**
 * Determines whether a list count or conversation change should auto-scroll
 * or increment the unread-below badge while keeping the user's reading position.
 */
export function computeAutoScrollDecision(
  prev: {
    resetKey: string | null;
    itemCount: number;
    tailKey?: string | null;
    nearBottom: boolean;
    unreadBelowCount: number;
  },
  next: {
    resetKey: string | null;
    itemCount: number;
    tailKey?: string | null;
  }
): AutoScrollDecision {
  if (next.resetKey !== prev.resetKey) {
    return {
      shouldScroll: true,
      behavior: 'auto',
      nextUnreadCount: 0,
    };
  }

  // Only treat itemCount growth as new bottom messages when the tail element changes
  // (or when tailKey tracking isn't provided). Prepending older history keeps tailKey fixed.
  const hasTailTracked = next.tailKey !== undefined && prev.tailKey !== undefined;
  const tailChanged = hasTailTracked ? next.tailKey !== prev.tailKey && next.tailKey !== null : true;

  if (next.itemCount > prev.itemCount && tailChanged) {
    const addedCount = next.itemCount - prev.itemCount;
    if (prev.nearBottom) {
      return {
        shouldScroll: true,
        behavior: 'smooth',
        nextUnreadCount: 0,
      };
    }

    return {
      shouldScroll: false,
      behavior: 'smooth',
      nextUnreadCount: prev.unreadBelowCount + addedCount,
    };
  }

  return {
    shouldScroll: false,
    behavior: 'auto',
    nextUnreadCount: next.itemCount === 0 ? 0 : prev.unreadBelowCount,
  };
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Keeps chat message lists pinned to the latest message only when the user is
 * already near the bottom; otherwise preserves scroll position and exposes a
 * jump-to-bottom control for unread messages below.
 */
export function useSmartAutoScroll({
  itemCount,
  resetKey,
  tailKey,
}: {
  itemCount: number;
  resetKey: string | null;
  tailKey?: string | null;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const prevStateRef = useRef<{ resetKey: string | null; itemCount: number; tailKey?: string | null }>({
    resetKey,
    itemCount,
    tailKey,
  });
  const unreadBelowCountRef = useRef(0);
  const [unreadBelowCount, setUnreadBelowCount] = useState(0);

  const updateUnreadCount = useCallback((nextCount: number) => {
    unreadBelowCountRef.current = nextCount;
    setUnreadBelowCount((prev) => (prev === nextCount ? prev : nextCount));
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      nearBottomRef.current = true;
      updateUnreadCount(0);
      const resolvedBehavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : behavior;
      endRef.current?.scrollIntoView({ behavior: resolvedBehavior, block: 'end' });
    },
    [updateUnreadCount]
  );

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const nearBottom = isScrolledNearBottom(
      container.scrollTop,
      container.clientHeight,
      container.scrollHeight
    );
    nearBottomRef.current = nearBottom;
    if (nearBottom) {
      updateUnreadCount(0);
    }
  }, [updateUnreadCount]);

  useEffect(() => {
    const prev = prevStateRef.current;
    const decision = computeAutoScrollDecision(
      {
        resetKey: prev.resetKey,
        itemCount: prev.itemCount,
        tailKey: prev.tailKey,
        nearBottom: nearBottomRef.current,
        unreadBelowCount: unreadBelowCountRef.current,
      },
      { resetKey, itemCount, tailKey }
    );
    prevStateRef.current = { resetKey, itemCount, tailKey };

    if (decision.shouldScroll) {
      nearBottomRef.current = true;
      updateUnreadCount(0);
      const resolvedBehavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : decision.behavior;
      endRef.current?.scrollIntoView({ behavior: resolvedBehavior, block: 'end' });
    } else if (decision.nextUnreadCount !== unreadBelowCountRef.current) {
      updateUnreadCount(decision.nextUnreadCount);
    }
  }, [itemCount, resetKey, tailKey, updateUnreadCount]);

  return {
    scrollContainerRef,
    endRef,
    handleScroll,
    unreadBelowCount,
    showNewMessageButton: unreadBelowCount > 0,
    scrollToBottom,
  };
}
