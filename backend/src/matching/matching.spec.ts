import { describe, it, expect, afterAll } from 'bun:test';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { MatchingEngine } from './matching.service.js';
import type { QueuedUser } from './matching.service.js';

const testNamespace = `chatible:test:matching:${crypto.randomUUID()}`;
const testRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true });
let engineNumber = 0;

afterAll(async () => {
  const keys = await testRedis.keys(`${testNamespace}:*`);
  if (keys.length > 0) await testRedis.del(...keys);
  await testRedis.quit();
});

const newTestEngine = (namespace = `${testNamespace}:${engineNumber++}`): MatchingEngine =>
  new MatchingEngine(testRedis, namespace);

const makeUser = (overrides: Partial<QueuedUser> = {}): QueuedUser => ({
  userId: 'user-a',
  socketId: 'socket-a',
  gender: 'MALE',
  age: 22,
  nickname: 'User A',
  targetGender: 'ALL',
  ageMin: 18,
  ageMax: 30,
  enqueuedAt: Date.now(),
  ...overrides,
});

describe('Atomic two-way matching queue', () => {
  it('matches only when both users accept each other by gender and age', async () => {
    const engine = newTestEngine();
    const userA = makeUser({ targetGender: 'FEMALE', ageMin: 18, ageMax: 25 });
    const userB = makeUser({
      userId: 'user-b',
      socketId: 'socket-b',
      nickname: 'User B',
      gender: 'FEMALE',
      age: 21,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 30,
    });

    expect(await engine.enqueue(userA)).toBeNull();
    expect(engine.getQueueSize()).toBe(1);
    const match = await engine.enqueue(userB);
    expect(match?.userA.userId).toBe(userB.userId);
    expect(match?.userB.userId).toBe(userA.userId);
    expect(engine.getQueueSize()).toBe(0);
  });

  it('keeps both users queued when either side rejects the age range', async () => {
    const engine = newTestEngine();
    const userA = makeUser({ gender: 'MALE', age: 35, targetGender: 'FEMALE', ageMin: 18, ageMax: 40 });
    const userB = makeUser({
      userId: 'user-b',
      socketId: 'socket-b',
      gender: 'FEMALE',
      age: 22,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 28,
    });

    expect(await engine.enqueue(userA)).toBeNull();
    expect(await engine.enqueue(userB)).toBeNull();
    expect(engine.getQueueSize()).toBe(2);
  });

  it('prevents an immediate repeat match with either prior partner', async () => {
    const engine = newTestEngine();
    const userA = makeUser({ lastPartnerId: 'user-b' });
    const userB = makeUser({
      userId: 'user-b',
      socketId: 'socket-b',
      gender: 'FEMALE',
      targetGender: 'ALL',
      lastPartnerId: 'user-a',
    });

    expect(await engine.enqueue(userA)).toBeNull();
    expect(await engine.enqueue(userB)).toBeNull();
    expect(engine.getQueueSize()).toBe(2);
  });

  it('finds a previously out-of-range partner after filter expansion', async () => {
    const engine = newTestEngine();
    const userA = makeUser({ targetGender: 'FEMALE', age: 28, ageMin: 18, ageMax: 22 });
    const userB = makeUser({
      userId: 'user-b',
      socketId: 'socket-b',
      gender: 'FEMALE',
      age: 25,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 30,
    });

    expect(await engine.enqueue(userA)).toBeNull();
    expect(await engine.enqueue(userB)).toBeNull();
    const match = await engine.expandFilter(userA.userId);
    expect(match?.userA.userId).toBe(userA.userId);
    expect(match?.userB.userId).toBe(userB.userId);
    expect(engine.getQueueSize()).toBe(0);
  });

  it('serializes concurrent enqueue operations so a user is matched only once', async () => {
    const engine = newTestEngine();
    engine.setBlockChecker(async () => {
      await Promise.resolve();
      return false;
    });
    const userA = makeUser({ targetGender: 'FEMALE' });
    const userB = makeUser({
      userId: 'user-b',
      socketId: 'socket-b',
      gender: 'FEMALE',
      targetGender: 'MALE',
    });

    const results = await Promise.all([engine.enqueue(userA), engine.enqueue(userB)]);
    const matches = results.filter((result) => result !== null);
    expect(matches).toHaveLength(1);
    expect(engine.getQueueSize()).toBe(0);
  });

  it('dequeues and restores users without duplicate queue entries', async () => {
    const engine = newTestEngine();
    const userA = makeUser();
    const userB = makeUser({ userId: 'user-b', socketId: 'socket-b', gender: 'FEMALE' });
    await engine.restoreUsers([userA]);
    await engine.restoreUsers([userA]);
    expect(engine.getQueueSize()).toBe(1);
    expect(await engine.dequeue(userA.userId)).toBe(true);
    expect(await engine.dequeue(userA.userId)).toBe(false);
    expect(await engine.enqueue(userA)).toBeNull();
    const match = await engine.enqueue(userB);
    expect(match?.userA.userId).toBe(userB.userId);
    expect(match?.userB.userId).toBe(userA.userId);
    expect(engine.getQueueSize()).toBe(0);
  });
  it('matches exactly once across independent engines sharing Redis', async () => {
    const namespace = `${testNamespace}:shared`;
    const engineA = newTestEngine(namespace);
    const engineB = newTestEngine(namespace);
    const userA = makeUser({ userId: 'cross-a', socketId: 'socket-cross-a', targetGender: 'FEMALE' });
    const userB = makeUser({
      userId: 'cross-b',
      socketId: 'socket-cross-b',
      gender: 'FEMALE',
      targetGender: 'MALE',
    });

    const [first, second] = await Promise.all([engineA.enqueue(userA), engineB.enqueue(userB)]);
    expect([first, second].filter((result) => result !== null)).toHaveLength(1);
    expect(await engineA.getQueueSizeAsync()).toBe(0);
    expect(await engineB.getQueueSizeAsync()).toBe(0);
  });

  it('skips blocked pairs via block checker and matches the next eligible indexed candidate', async () => {
    const engine = newTestEngine();
    engine.setBlockChecker((a, b) => (a === 'seeker' && b === 'blocked-b') || (a === 'blocked-b' && b === 'seeker'));

    const blockedCandidate = makeUser({
      userId: 'blocked-b',
      socketId: 'sock-blocked',
      gender: 'FEMALE',
      age: 24,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 30,
    });
    const eligibleCandidate = makeUser({
      userId: 'eligible-c',
      socketId: 'sock-eligible',
      gender: 'FEMALE',
      age: 25,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 30,
    });
    const seeker = makeUser({
      userId: 'seeker',
      socketId: 'sock-seeker',
      gender: 'MALE',
      age: 25,
      targetGender: 'FEMALE',
      ageMin: 20,
      ageMax: 30,
    });

    expect(await engine.enqueue(blockedCandidate)).toBeNull();
    expect(await engine.enqueue(eligibleCandidate)).toBeNull();
    const match = await engine.enqueue(seeker);
    expect(match?.userB.userId).toBe('eligible-c');
    expect(await engine.getQueueSizeAsync()).toBe(1);
  });

  it('updates index buckets cleanly when a queued user re-enqueues with updated preferences', async () => {
    const namespace = `${testNamespace}:reenqueue`;
    const engine = newTestEngine(namespace);

    const oldEntry = makeUser({
      userId: 'reuser',
      socketId: 'sock-1',
      gender: 'MALE',
      age: 22,
      targetGender: 'FEMALE',
      ageMin: 20,
      ageMax: 25,
    });
    const updatedEntry = makeUser({
      userId: 'reuser',
      socketId: 'sock-2',
      gender: 'MALE',
      age: 32,
      targetGender: 'OTHER',
      ageMin: 28,
      ageMax: 35,
    });
    const oldTargetProbe = makeUser({
      userId: 'female-probe',
      socketId: 'sock-fp',
      gender: 'FEMALE',
      age: 23,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 25,
    });

    expect(await engine.enqueue(oldEntry)).toBeNull();
    expect(await engine.enqueue(updatedEntry)).toBeNull();
    expect(await engine.enqueue(oldTargetProbe)).toBeNull();
    expect(await testRedis.zcard(`${namespace}:idx:MALE:FEMALE`)).toBe(0);
    expect(await testRedis.zcard(`${namespace}:idx:MALE:OTHER`)).toBe(1);
    expect(await engine.getQueueSizeAsync()).toBe(2);
  });

  it('matches eligible candidates strictly in FIFO enqueue order regardless of age', async () => {
    const engine = newTestEngine();
    const olderFirst = makeUser({
      userId: 'older-first',
      socketId: 'sock-30',
      gender: 'FEMALE',
      age: 30,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 35,
    });
    const youngerSecond = makeUser({
      userId: 'younger-second',
      socketId: 'sock-20',
      gender: 'FEMALE',
      age: 20,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 35,
    });
    const seeker1 = makeUser({
      userId: 'seeker-1',
      socketId: 'sock-s1',
      gender: 'MALE',
      age: 25,
      targetGender: 'FEMALE',
      ageMin: 18,
      ageMax: 35,
    });

    expect(await engine.enqueue(olderFirst)).toBeNull();
    expect(await engine.enqueue(youngerSecond)).toBeNull();

    const firstMatch = await engine.enqueue(seeker1);
    expect(firstMatch?.userB.userId).toBe('older-first');

    const seeker2 = makeUser({
      userId: 'seeker-2',
      socketId: 'sock-s2',
      gender: 'MALE',
      age: 25,
      targetGender: 'FEMALE',
      ageMin: 18,
      ageMax: 35,
    });
    const secondMatch = await engine.enqueue(seeker2);
    expect(secondMatch?.userB.userId).toBe('younger-second');
    expect(await engine.getQueueSizeAsync()).toBe(0);
  });

  it('preserves FIFO seniority when expandFilter updates an earlier waiting user', async () => {
    const engine = newTestEngine();
    const earlyWaiter = makeUser({
      userId: 'early-waiter',
      socketId: 'sock-early',
      gender: 'FEMALE',
      age: 30,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 24,
    });
    const lateWaiter = makeUser({
      userId: 'late-waiter',
      socketId: 'sock-late',
      gender: 'FEMALE',
      age: 22,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 30,
    });

    expect(await engine.enqueue(earlyWaiter)).toBeNull();
    expect(await engine.enqueue(lateWaiter)).toBeNull();
    // Expand earlyWaiter to 18..29; should stay ahead of lateWaiter when seeker aged 26 joins.
    expect(await engine.expandFilter(earlyWaiter.userId)).toBeNull();

    const seeker = makeUser({
      userId: 'seeker-26',
      socketId: 'sock-s26',
      gender: 'MALE',
      age: 26,
      targetGender: 'FEMALE',
      ageMin: 18,
      ageMax: 35,
    });
    const match = await engine.enqueue(seeker);
    expect(match?.userB.userId).toBe('early-waiter');
  });
});
