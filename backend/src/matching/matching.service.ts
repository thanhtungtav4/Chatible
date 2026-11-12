import { Gender, TargetGender } from '@chatible/shared';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { config } from '../config/env.js';

export interface QueuedUser {
  userId: string;
  socketId: string;
  gender: Gender;
  age: number;
  nickname: string;
  targetGender: TargetGender;
  ageMin: number;
  ageMax: number;
  lastPartnerId?: string;
  allowExpansion?: boolean;
  enqueuedAt: number;
}

export interface MatchResult {
  sessionId: string;
  userA: QueuedUser;
  userB: QueuedUser;
  ownerInstanceId: string;
  matchedAt: string;
}

const RELEASE_LOCK_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

/**
 * Redis-backed two-way matching engine.
 *
 * Redis is the queue's source of truth. A short-lived distributed lock protects
 * the read/check/remove sequence, including the asynchronous block check, so
 * two backend instances cannot consume the same candidate.
 */
export class MatchingEngine {
  readonly instanceId = crypto.randomUUID();
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;
  private readonly queueKey: string;
  readonly namespace: string;
  private readonly lockKey: string;
  private readonly lockToken = crypto.randomUUID();
  private connectPromise?: Promise<void>;
  private observedQueueSize = 0;
  private isBlockedFn?: (userA: string, userB: string) => Promise<boolean> | boolean;

  constructor(redisOrUrl: Redis | string = config.redisUrl, namespace = 'chatible:matching') {
    this.namespace = namespace;
    this.ownsRedis = typeof redisOrUrl === 'string';
    this.redis = typeof redisOrUrl === 'string'
      ? new Redis(redisOrUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      })
      : redisOrUrl;
    this.queueKey = `${namespace}:queue`;
    this.lockKey = `${namespace}:lock`;
  }

  /** Connect during application startup. Failure is intentional and must abort startup. */
  async connect(): Promise<void> {
    if (this.redis.status === 'ready') return;
    if (!this.connectPromise) {
      this.connectPromise = this.redis.connect().finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
  }
  async close(): Promise<void> {
    if (this.ownsRedis && this.redis.status !== 'end') await this.redis.quit();
  }

  setBlockChecker(fn: (userA: string, userB: string) => Promise<boolean> | boolean): void {
    this.isBlockedFn = fn;
  }

  /** Enqueue a user or atomically consume one mutually compatible candidate. */
  async enqueue(user: QueuedUser): Promise<MatchResult | null> {
    return this.withQueueLock(async () => {
      // Re-enqueueing a user replaces an old socket/filters and never creates a duplicate.
      await this.redis.hdel(this.queueKey, user.userId);
      const match = await this.findMatch(user);
      if (!match) {
        await this.redis.hset(this.queueKey, user.userId, JSON.stringify(user));
        return null;
      }
      await this.redis.hdel(this.queueKey, match.userId);
      return this.createMatch(user, match);
    });
  }

  /** Remove a user from the shared queue. */
  async dequeue(userId: string): Promise<boolean> {
    return this.withQueueLock(async () => (await this.redis.hdel(this.queueKey, userId)) === 1);
  }

  /** Expand age filters and retry matching while holding the distributed lock. */
  async expandFilter(userId: string): Promise<MatchResult | null> {
    return this.withQueueLock(async () => {
      const encoded = await this.redis.hget(this.queueKey, userId);
      if (!encoded) return null;
      const user = this.parseUser(encoded);
      user.allowExpansion = true;
      user.ageMin = Math.max(18, user.ageMin - 5);
      user.ageMax = Math.min(80, user.ageMax + 5);
      await this.redis.hset(this.queueKey, user.userId, JSON.stringify(user));

      const match = await this.findMatch(user);
      if (!match) return null;
      await this.redis.hdel(this.queueKey, user.userId, match.userId);
      return this.createMatch(user, match);
    });
  }

  /** Restore users after persistence failure without overwriting a newer queue entry. */
  async restoreUsers(usersToRestore: QueuedUser[]): Promise<void> {
    await this.withQueueLock(async () => {
      for (const user of usersToRestore) {
        await this.redis.hsetnx(this.queueKey, user.userId, JSON.stringify(user));
      }
    });
  }

  /**
   * Synchronous compatibility metric for existing gateway code. It is only a
   * last-observed value; queue ownership and decisions remain entirely in Redis.
   */
  getQueueSize(): number {
    return this.observedQueueSize;
  }

  /** Authoritative queue size for diagnostics and distributed tests. */
  async getQueueSizeAsync(): Promise<number> {
    await this.connect();
    const size = await this.redis.hlen(this.queueKey);
    this.observedQueueSize = size;
    return size;
  }

  private async withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.connect();
    const deadline = Date.now() + 30_000;
    let locked = false;
    while (!locked) {
      locked = (await this.redis.set(this.lockKey, this.lockToken, 'PX', 30_000, 'NX')) === 'OK';
      if (locked) break;
      if (Date.now() >= deadline) throw new Error('Redis matching lock could not be acquired');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    try {
      return await operation();
    } finally {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, this.lockKey, this.lockToken);
      this.observedQueueSize = await this.redis.hlen(this.queueKey);
    }
  }

  private async findMatch(candidateA: QueuedUser): Promise<QueuedUser | null> {
    const queued = await this.redis.hgetall(this.queueKey);
    for (const encoded of Object.values(queued)) {
      const candidateB = this.parseUser(encoded);
      if (candidateA.userId === candidateB.userId) continue;
      if (candidateA.lastPartnerId === candidateB.userId || candidateB.lastPartnerId === candidateA.userId) continue;

      const aAcceptsBGender = candidateA.targetGender === 'ALL' || candidateA.targetGender === candidateB.gender;
      const bAcceptsAGender = candidateB.targetGender === 'ALL' || candidateB.targetGender === candidateA.gender;
      if (!aAcceptsBGender || !bAcceptsAGender) continue;

      const aAcceptsBAge = candidateB.age >= candidateA.ageMin && candidateB.age <= candidateA.ageMax;
      const bAcceptsAAge = candidateA.age >= candidateB.ageMin && candidateA.age <= candidateB.ageMax;
      if (!aAcceptsBAge || !bAcceptsAAge) continue;

      if (this.isBlockedFn && (await this.isBlockedFn(candidateA.userId, candidateB.userId))) continue;
      return candidateB;
    }
    return null;
  }

  private createMatch(userA: QueuedUser, userB: QueuedUser): MatchResult {
    return {
      sessionId: crypto.randomUUID(),
      userA,
      userB,
      ownerInstanceId: this.instanceId,
      matchedAt: new Date().toISOString(),
    };
  }

  private parseUser(encoded: string): QueuedUser {
    try {
      return JSON.parse(encoded) as QueuedUser;
    } catch {
      throw new Error('Redis matching queue contains malformed user data');
    }
  }
}
