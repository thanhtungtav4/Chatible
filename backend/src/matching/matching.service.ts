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

const ALL_GENDERS: readonly Gender[] = ['MALE', 'FEMALE', 'OTHER'];
const CANDIDATE_FETCH_CHUNK_SIZE = 32;

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
  private readonly fifoKey: string;
  private readonly seqKey: string;
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
    this.fifoKey = `${namespace}:fifo`;
    this.seqKey = `${namespace}:seq`;
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
      await this.removeExistingUserIfPresent(user.userId);
      const match = await this.findMatch(user);
      if (!match) {
        await this.addUsersToQueueAndIndex([user]);
        return null;
      }
      await this.removeUsersFromQueueAndIndex([match]);
      return this.createMatch(user, match);
    });
  }

  /** Remove a user from the shared queue. */
  async dequeue(userId: string): Promise<boolean> {
    return this.withQueueLock(async () => {
      const existingEncoded = await this.redis.hget(this.queueKey, userId);
      if (!existingEncoded) return false;
      await this.removeUsersFromQueueAndIndex([this.parseUser(existingEncoded)]);
      return true;
    });
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
      await this.removeUsersFromQueueAndIndex([user, match]);
      return this.createMatch(user, match);
    });
  }

  /** Restore users after persistence failure without overwriting a newer queue entry. */
  async restoreUsers(usersToRestore: QueuedUser[]): Promise<void> {
    if (usersToRestore.length === 0) return;
    await this.withQueueLock(async () => {
      const uniqueUsers: QueuedUser[] = [];
      const seen = new Set<string>();
      for (const user of usersToRestore) {
        if (seen.has(user.userId)) continue;
        seen.add(user.userId);
        uniqueUsers.push(user);
      }

      const existing = await this.redis.hmget(
        this.queueKey,
        ...uniqueUsers.map((user) => user.userId)
      );
      const missingUsers = uniqueUsers
        .filter((_, index) => existing[index] === null)
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      if (missingUsers.length > 0) {
        await this.addUsersToQueueAndIndex(missingUsers);
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
    let backoffMs = 2;
    while (!locked) {
      locked = (await this.redis.set(this.lockKey, this.lockToken, 'PX', 30_000, 'NX')) === 'OK';
      if (locked) break;
      if (Date.now() >= deadline) throw new Error('Redis matching lock could not be acquired');
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(20, backoffMs * 2);
    }

    try {
      return await operation();
    } finally {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, this.lockKey, this.lockToken);
      this.observedQueueSize = await this.redis.hlen(this.queueKey);
    }
  }

  private indexBucketKey(gender: Gender, targetGender: TargetGender): string {
    return `${this.namespace}:idx:${gender}:${targetGender}`;
  }

  private compatibleBucketKeysFor(candidateA: QueuedUser): string[] {
    const acceptedGenders = candidateA.targetGender === 'ALL' ? ALL_GENDERS : [candidateA.targetGender];
    const reciprocalTargets: readonly TargetGender[] = ['ALL', candidateA.gender];
    const keys: string[] = [];
    for (const candidateGender of acceptedGenders) {
      for (const candidateTarget of reciprocalTargets) {
        keys.push(this.indexBucketKey(candidateGender, candidateTarget));
      }
    }
    return keys;
  }

  private async addUsersToQueueAndIndex(users: QueuedUser[]): Promise<void> {
    if (users.length === 0) return;
    const endSeq = await this.redis.incrby(this.seqKey, users.length);
    const startSeq = endSeq - users.length + 1;
    const pipeline = this.redis.pipeline();
    for (let i = 0; i < users.length; i++) {
      const user = users[i]!;
      pipeline.hset(this.queueKey, user.userId, JSON.stringify(user));
      pipeline.zadd(this.indexBucketKey(user.gender, user.targetGender), user.age, user.userId);
      pipeline.zadd(this.fifoKey, startSeq + i, user.userId);
    }
    await pipeline.exec();
  }

  private async removeUsersFromQueueAndIndex(
    users: Array<Pick<QueuedUser, 'userId' | 'gender' | 'targetGender'>>
  ): Promise<void> {
    if (users.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const user of users) {
      pipeline.hdel(this.queueKey, user.userId);
      pipeline.zrem(this.indexBucketKey(user.gender, user.targetGender), user.userId);
      pipeline.zrem(this.fifoKey, user.userId);
    }
    await pipeline.exec();
  }

  private async removeExistingUserIfPresent(userId: string): Promise<void> {
    const existingEncoded = await this.redis.hget(this.queueKey, userId);
    if (!existingEncoded) return;
    await this.removeUsersFromQueueAndIndex([this.parseUser(existingEncoded)]);
  }

  private async orderCandidateIdsByFifo(candidateIds: string[]): Promise<string[]> {
    if (candidateIds.length <= 1) return candidateIds;
    const rawScores = await this.redis.zmscore(this.fifoKey, ...candidateIds);
    return candidateIds
      .map((id, index) => {
        const rawScore = rawScores[index];
        return {
          id,
          fifoOrder: rawScore === null || rawScore === undefined ? Number.MAX_SAFE_INTEGER : Number(rawScore),
        };
      })
      .sort((a, b) => a.fifoOrder - b.fifoOrder || a.id.localeCompare(b.id))
      .map((entry) => entry.id);
  }

  private async findMatch(candidateA: QueuedUser): Promise<QueuedUser | null> {
    const bucketKeys = this.compatibleBucketKeysFor(candidateA);
    const bucketPipeline = this.redis.pipeline();
    for (const bucketKey of bucketKeys) {
      bucketPipeline.zrangebyscore(bucketKey, candidateA.ageMin, candidateA.ageMax);
    }
    const bucketResults = await bucketPipeline.exec();
    const candidateIdSet = new Set<string>();
    if (bucketResults) {
      for (const [err, ids] of bucketResults) {
        if (err) throw err;
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
          if (typeof id !== 'string') continue;
          if (id === candidateA.userId || id === candidateA.lastPartnerId) continue;
          candidateIdSet.add(id);
        }
      }
    }

    if (candidateIdSet.size === 0) {
      return null;
    }

    const candidateIds = await this.orderCandidateIdsByFifo(Array.from(candidateIdSet));
    for (let offset = 0; offset < candidateIds.length; offset += CANDIDATE_FETCH_CHUNK_SIZE) {
      const chunkIds = candidateIds.slice(offset, offset + CANDIDATE_FETCH_CHUNK_SIZE);
      const encodedChunk = await this.redis.hmget(this.queueKey, ...chunkIds);
      for (const encoded of encodedChunk) {
        if (!encoded) continue;
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
