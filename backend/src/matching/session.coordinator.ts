import crypto from 'node:crypto';
import Redis from 'ioredis';
import { config } from '../config/env.js';
import type { MatchResult } from './matching.service.js';

export type CoordinatedSessionState = 'CHATTING' | 'RECONNECTING' | 'ENDED';

export interface CoordinatedSession {
  sessionId: string;
  userAId: string;
  userASocketId: string;
  userBId: string;
  userBSocketId: string;
  ownerInstanceId: string;
  state: CoordinatedSessionState;
  reconnectUntil?: number;
  reconnectingUsers?: Record<string, number>;
  endReason?: string;
}

export type SessionNotification =
  | { type: 'MATCH_CREATED'; match: MatchResult }
  | { type: 'SESSION_UPDATED'; session: CoordinatedSession };

export type SessionNotificationHandler = (notification: SessionNotification) => void | Promise<void>;

const RELEASE_LOCK_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

/**
 * Redis coordinator for the session state that cannot remain in a gateway's
 * process-local maps. It also provides the pub/sub channel used to notify every
 * Socket.IO instance about matches, reconnects, and session termination.
 */
export class RedisSessionCoordinator {
  readonly instanceId: string;
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;
  readonly namespace: string;
  private readonly channel: string;
  private readonly lockToken = crypto.randomUUID();
  private publisher?: Redis;
  private subscriber?: Redis;
  private connectPromise?: Promise<void>;
  private handler?: SessionNotificationHandler;

  constructor(
    redisOrUrl: Redis | string = config.redisUrl,
    namespace = 'chatible:matching',
    instanceId = crypto.randomUUID(),
  ) {
    this.ownsRedis = typeof redisOrUrl === 'string';
    this.redis = typeof redisOrUrl === 'string'
      ? new Redis(redisOrUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      })
      : redisOrUrl;
    this.namespace = namespace;
    this.channel = `${namespace}:session-events`;
    this.instanceId = instanceId;
  }

  async connect(): Promise<void> {
    if (this.publisher && this.subscriber) return;
    if (!this.connectPromise) {
      this.connectPromise = this.openConnections().finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
  }

  isOwner(match: MatchResult): boolean {
    return match.ownerInstanceId === this.instanceId;
  }
  async publishMatch(match: MatchResult): Promise<void> {
    await this.connect();
    await this.publisher!.publish(this.channel, JSON.stringify({ type: 'MATCH_CREATED', match } satisfies SessionNotification));
  }

  async subscribe(handler: SessionNotificationHandler): Promise<void> {
    if (this.handler) throw new Error('Redis session coordinator already has a subscriber');
    this.handler = handler;
    await this.connect();
    await this.subscriber!.subscribe(this.channel);
  }

  /** Create the shared record once, then return it from every gateway instance. */
  async ensureSession(match: MatchResult): Promise<CoordinatedSession> {
    return this.withLock(async () => {
      const existing = await this.redis.get(this.sessionKey(match.sessionId));
      if (existing) return this.parseSession(existing);

      for (const userId of [match.userA.userId, match.userB.userId]) {
        const currentSessionId = await this.redis.get(this.userKey(userId));
        if (!currentSessionId) continue;
        const currentEncoded = await this.redis.get(this.sessionKey(currentSessionId));
        if (!currentEncoded) {
          await this.redis.del(this.userKey(userId));
          continue;
        }
        if (this.parseSession(currentEncoded).state !== 'ENDED') {
          throw new Error('User already has an active chat session.');
        }
        await this.redis.del(this.userKey(userId));
      }

      const session: CoordinatedSession = {
        sessionId: match.sessionId,
        userAId: match.userA.userId,
        userASocketId: match.userA.socketId,
        userBId: match.userB.userId,
        userBSocketId: match.userB.socketId,
        ownerInstanceId: match.ownerInstanceId,
        state: 'CHATTING',
      };
      await this.writeSession(session);
      return session;
    });
  }

  async getSessionByUser(userId: string): Promise<CoordinatedSession | null> {
    await this.connect();
    const sessionId = await this.redis.get(this.userKey(userId));
    if (!sessionId) return null;
    const encoded = await this.redis.get(this.sessionKey(sessionId));
    if (!encoded) return null;
    const session = this.parseSession(encoded);
    const now = Date.now();
    const hasExpiredReconnect = Object.values(session.reconnectingUsers ?? {}).some((deadline) => deadline <= now)
      || (Object.keys(session.reconnectingUsers ?? {}).length === 0 && (session.reconnectUntil ?? Infinity) <= now);
    if (session.state === 'RECONNECTING' && hasExpiredReconnect) {
      return (await this.endIfReconnectExpired(sessionId, now)) ?? session;
    }
    return session;
  }

  async updateSocket(sessionId: string, userId: string, socketId: string): Promise<CoordinatedSession> {
    return this.withLock(async () => {
      const session = await this.requireSession(sessionId);
      const deadline = session.reconnectingUsers?.[userId];
      if (session.state !== 'RECONNECTING' || deadline === undefined || deadline <= Date.now()) {
        throw new Error('Chat session is no longer available for reconnect.');
      }
      if (session.userAId === userId) session.userASocketId = socketId;
      else if (session.userBId === userId) session.userBSocketId = socketId;
      else throw new Error('User is not a participant in this session');
      const reconnectingUsers = { ...session.reconnectingUsers };
      delete reconnectingUsers[userId];
      session.reconnectingUsers = Object.keys(reconnectingUsers).length > 0 ? reconnectingUsers : undefined;
      session.state = session.reconnectingUsers ? 'RECONNECTING' : 'CHATTING';
      session.reconnectUntil = session.reconnectingUsers
        ? Math.min(...Object.values(session.reconnectingUsers))
        : undefined;
      await this.writeSession(session);
      await this.publishUpdate(session);
      return session;
    });
  }

  async markDisconnected(userId: string, socketId: string): Promise<CoordinatedSession | null> {
    return this.withLock(async () => {
      const sessionId = await this.redis.get(this.userKey(userId));
      if (!sessionId) return null;
      const session = await this.requireSession(sessionId);
      if (session.state !== 'CHATTING' && session.state !== 'RECONNECTING') return null;
      const currentSocketId = session.userAId === userId
        ? session.userASocketId
        : session.userBId === userId
          ? session.userBSocketId
          : null;
      if (currentSocketId !== socketId) return null;
      const reconnectingUsers = { ...session.reconnectingUsers, [userId]: Date.now() + 30_000 };
      session.state = 'RECONNECTING';
      session.reconnectingUsers = reconnectingUsers;
      session.reconnectUntil = Math.min(...Object.values(reconnectingUsers));
      await this.writeSession(session);
      await this.publishUpdate(session);
      return session;
    });
  }

  async setState(sessionId: string, state: 'ENDED', endReason?: string): Promise<CoordinatedSession> {
    return this.withLock(async () => {
      const session = await this.requireSession(sessionId);
      if (session.state === 'ENDED') return session;
      session.state = state;
      session.endReason = endReason;
      session.reconnectUntil = undefined;
      session.reconnectingUsers = undefined;
      await this.writeSession(session);
      await this.redis.del(this.userKey(session.userAId), this.userKey(session.userBId));
      await this.publishUpdate(session);
      return session;
    });
  }

  async endIfReconnectExpired(sessionId: string, now = Date.now()): Promise<CoordinatedSession | null> {
    return this.withLock(async () => {
      const session = await this.requireSession(sessionId);
      const deadlines = Object.values(session.reconnectingUsers ?? {});
      const hasExpiredDeadline = deadlines.length > 0
        ? deadlines.some((deadline) => deadline <= now)
        : (session.reconnectUntil ?? Infinity) <= now;
      if (session.state !== 'RECONNECTING' || !hasExpiredDeadline) return null;
      session.state = 'ENDED';
      session.endReason = 'TIMEOUT';
      session.reconnectUntil = undefined;
      session.reconnectingUsers = undefined;
      await this.writeSession(session);
      await this.redis.del(this.userKey(session.userAId), this.userKey(session.userBId));
      await this.publishUpdate(session);
      return session;
    });
  }

  async close(): Promise<void> {
    await Promise.all([
      this.publisher?.quit(),
      this.subscriber?.quit(),
      this.ownsRedis ? this.redis.quit() : undefined,
    ]);
  }

  private async openConnections(): Promise<void> {
    await this.connectRedis(this.redis);
    this.publisher = this.redis.duplicate();
    this.subscriber = this.redis.duplicate();
    await Promise.all([this.connectRedis(this.publisher), this.connectRedis(this.subscriber)]);
    this.subscriber.on('message', (_channel, payload) => {
      if (!this.handler) return;
      try {
        const notification = JSON.parse(payload) as SessionNotification;
        void this.handler(notification);
      } catch {
        // Ignore malformed external messages; session state remains Redis-authoritative.
      }
    });
  }

  private async connectRedis(client: Redis): Promise<void> {
    if (client.status !== 'ready') await client.connect();
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.connect();
    const lockKey = `${this.namespace}:session-lock`;
    const deadline = Date.now() + 10_000;
    while ((await this.redis.set(lockKey, this.lockToken, 'PX', 10_000, 'NX')) !== 'OK') {
      if (Date.now() >= deadline) throw new Error('Redis session lock could not be acquired');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    try {
      return await operation();
    } finally {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, this.lockToken);
    }
  }

  private async requireSession(sessionId: string): Promise<CoordinatedSession> {
    const encoded = await this.redis.get(this.sessionKey(sessionId));
    if (!encoded) throw new Error('Chat session not found');
    return this.parseSession(encoded);
  }

  private async writeSession(session: CoordinatedSession): Promise<void> {
    const ttlSeconds = 7 * 24 * 60 * 60;
    await this.redis.set(this.sessionKey(session.sessionId), JSON.stringify(session), 'EX', ttlSeconds);
    if (session.state === 'ENDED') {
      await this.redis.del(this.userKey(session.userAId), this.userKey(session.userBId));
    } else {
      await this.redis.set(this.userKey(session.userAId), session.sessionId, 'EX', ttlSeconds);
      await this.redis.set(this.userKey(session.userBId), session.sessionId, 'EX', ttlSeconds);
    }
  }

  private async publishUpdate(session: CoordinatedSession): Promise<void> {
    await this.publisher!.publish(this.channel, JSON.stringify({ type: 'SESSION_UPDATED', session } satisfies SessionNotification));
  }

  private sessionKey(sessionId: string): string {
    return `${this.namespace}:session:${sessionId}`;
  }

  private userKey(userId: string): string {
    return `${this.namespace}:user-session:${userId}`;
  }

  private parseSession(encoded: string): CoordinatedSession {
    return JSON.parse(encoded) as CoordinatedSession;
  }
}

