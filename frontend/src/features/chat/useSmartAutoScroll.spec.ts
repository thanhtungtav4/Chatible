import { describe, expect, test } from 'bun:test';
import { computeAutoScrollDecision, isScrolledNearBottom } from './useSmartAutoScroll.js';

describe('isScrolledNearBottom', () => {
  test('returns true when scroll offset is within the bottom threshold', () => {
    expect(isScrolledNearBottom(420, 400, 900)).toBe(true); // distance = 80 <= 96
    expect(isScrolledNearBottom(500, 400, 900)).toBe(true); // distance = 0
  });

  test('returns false when user has scrolled far above latest messages', () => {
    expect(isScrolledNearBottom(200, 400, 900)).toBe(false); // distance = 300 > 96
  });
});

describe('computeAutoScrollDecision', () => {
  test('resets unread badge and auto-scrolls on session or thread switch', () => {
    const result = computeAutoScrollDecision(
      {
        resetKey: 'session-a',
        itemCount: 30,
        nearBottom: false,
        unreadBelowCount: 4,
      },
      {
        resetKey: 'session-b',
        itemCount: 12,
      }
    );

    expect(result).toEqual({
      shouldScroll: true,
      behavior: 'auto',
      nextUnreadCount: 0,
    });
  });

  test('auto-scrolls smoothly when near bottom and a new message arrives', () => {
    const result = computeAutoScrollDecision(
      {
        resetKey: 'session-a',
        itemCount: 5,
        nearBottom: true,
        unreadBelowCount: 0,
      },
      {
        resetKey: 'session-a',
        itemCount: 6,
      }
    );

    expect(result).toEqual({
      shouldScroll: true,
      behavior: 'smooth',
      nextUnreadCount: 0,
    });
  });

  test('preserves scroll position and increments unread counter when scrolled up', () => {
    const result = computeAutoScrollDecision(
      {
        resetKey: 'session-a',
        itemCount: 20,
        tailKey: 'm-20',
        nearBottom: false,
        unreadBelowCount: 1,
      },
      {
        resetKey: 'session-a',
        itemCount: 23,
        tailKey: 'm-23',
      }
    );

    expect(result).toEqual({
      shouldScroll: false,
      behavior: 'smooth',
      nextUnreadCount: 4,
    });
  });

  test('ignores prepended older messages when tailKey remains unchanged', () => {
    const result = computeAutoScrollDecision(
      {
        resetKey: 'friend-a',
        itemCount: 40,
        tailKey: 'm-100',
        nearBottom: false,
        unreadBelowCount: 0,
      },
      {
        resetKey: 'friend-a',
        itemCount: 80,
        tailKey: 'm-100',
      }
    );

    expect(result).toEqual({
      shouldScroll: false,
      behavior: 'auto',
      nextUnreadCount: 0,
    });
  });
});
