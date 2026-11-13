import { describe, expect, it } from 'bun:test';
import { mergeFriendMessages, type OrderedFriendMessage } from './friendMessageOrder.js';

interface TestMessage extends OrderedFriendMessage {
  content: string;
}

describe('mergeFriendMessages', () => {
  it('retains realtime messages delivered while initial history page was in flight', () => {
    const realtimeDuringFetch: TestMessage[] = [
      { id: '00000000-0000-4000-8000-000000000003', sentAt: '2026-11-12T10:00:03.000Z', content: 'live' },
    ];
    const initialHistoryPage: TestMessage[] = [
      { id: '00000000-0000-4000-8000-000000000001', sentAt: '2026-11-12T10:00:01.000Z', content: 'older-1' },
      { id: '00000000-0000-4000-8000-000000000002', sentAt: '2026-11-12T10:00:02.000Z', content: 'older-2' },
    ];

    const merged = mergeFriendMessages(realtimeDuringFetch, initialHistoryPage);
    expect(merged.map((m) => m.content)).toEqual(['older-1', 'older-2', 'live']);
  });

  it('deduplicates by message ID and sorts tied timestamps deterministically by UUID', () => {
    const existing: TestMessage[] = [
      { id: '00000000-0000-4000-8000-00000000000b', sentAt: '2026-11-12T10:00:02.000Z', content: 'second-tie' },
    ];
    const fetched: TestMessage[] = [
      { id: '00000000-0000-4000-8000-00000000000a', sentAt: '2026-11-12T10:00:02.000Z', content: 'first-tie' },
      { id: '00000000-0000-4000-8000-00000000000b', sentAt: '2026-11-12T10:00:02.000Z', content: 'second-tie' },
    ];

    const merged = mergeFriendMessages(existing, fetched);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.content)).toEqual(['first-tie', 'second-tie']);
  });
});
