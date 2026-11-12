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
});
