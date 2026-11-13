export interface OrderedFriendMessage {
  id: string;
  sentAt: string;
}

function compareServerMessages(a: OrderedFriendMessage, b: OrderedFriendMessage): number {
  const timeA = Date.parse(a.sentAt);
  const timeB = Date.parse(b.sentAt);
  const validA = Number.isFinite(timeA);
  const validB = Number.isFinite(timeB);
  if (validA && validB && timeA !== timeB) {
    return timeA - timeB;
  }
  if (a.sentAt !== b.sentAt) {
    return a.sentAt.localeCompare(b.sentAt);
  }
  return a.id.localeCompare(b.id);
}

/**
 * Merges two message lists by unique server message ID and sorts chronologically
 * using server `(sentAt, id)` order so in-flight HTTP fetches never overwrite
 * concurrent realtime socket deliveries.
 */
export function mergeFriendMessages<T extends OrderedFriendMessage>(
  current: readonly T[],
  incoming: readonly T[]
): T[] {
  if (incoming.length === 0) {
    return current as T[];
  }
  const byId = new Map<string, T>();
  for (const msg of current) {
    byId.set(msg.id, msg);
  }
  for (const msg of incoming) {
    byId.set(msg.id, msg);
  }
  return Array.from(byId.values()).sort(compareServerMessages);
}
