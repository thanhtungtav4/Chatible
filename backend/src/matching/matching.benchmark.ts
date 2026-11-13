import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Redis from 'ioredis';
import { MatchingEngine, type QueuedUser } from './matching.service.js';

interface BenchmarkScenario {
  name: string;
  queueSize: number;
  matchRate: '0%' | '10%' | '50%';
  iterations: number;
  withBlockCheckMs?: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function summarizeDurations(label: string, samplesMs: number[]) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const avg = sum / Math.max(1, sorted.length);
  console.log(
    `${label.padEnd(46)} | avg=${avg.toFixed(2).padStart(6)}ms | p50=${percentile(sorted, 50).toFixed(2).padStart(6)}ms | p95=${percentile(sorted, 95).toFixed(2).padStart(6)}ms | max=${percentile(sorted, 100).toFixed(2).padStart(6)}ms`
  );
}

function buildQueuedUser(index: number, compatible: boolean): QueuedUser {
  if (compatible) {
    return {
      userId: `bench-compat-${index}`,
      socketId: `sock-${index}`,
      gender: 'FEMALE',
      age: 24,
      nickname: `Compat ${index}`,
      targetGender: 'MALE',
      ageMin: 20,
      ageMax: 30,
      enqueuedAt: Date.now() - index,
    };
  }
  return {
    userId: `bench-incompat-${index}`,
    socketId: `sock-${index}`,
    gender: 'FEMALE',
    age: 35 + (index % 15),
    nickname: `Incompat ${index}`,
    targetGender: 'FEMALE',
    ageMin: 30,
    ageMax: 50,
    enqueuedAt: Date.now() - index,
  };
}

async function seedQueueDirectly(
  engine: MatchingEngine,
  queueSize: number,
  matchRate: '0%' | '10%' | '50%'
): Promise<void> {
  const compatibleInterval = matchRate === '50%' ? 2 : matchRate === '10%' ? 10 : Number.POSITIVE_INFINITY;
  const users: QueuedUser[] = [];
  for (let i = 0; i < queueSize; i++) {
    const isCompat = compatibleInterval !== Number.POSITIVE_INFINITY && i % compatibleInterval === 0;
    users.push(buildQueuedUser(i, isCompat));
  }
  await engine.restoreUsers(users);
}

async function runScenario(redis: Redis, scenario: BenchmarkScenario): Promise<void> {
  const ns = `chatible:bench:${crypto.randomUUID()}`;
  const engine = new MatchingEngine(redis, ns);
  if (scenario.withBlockCheckMs) {
    engine.setBlockChecker(async () => {
      await new Promise((r) => setTimeout(r, scenario.withBlockCheckMs));
      return false;
    });
  }

  try {
    await seedQueueDirectly(engine, scenario.queueSize, scenario.matchRate);
    const probeSamples: number[] = [];
    for (let i = 0; i < scenario.iterations; i++) {
      const probe: QueuedUser = {
        userId: `probe-${i}`,
        socketId: `probe-sock-${i}`,
        gender: 'MALE',
        age: 25,
        nickname: `Probe ${i}`,
        targetGender: 'FEMALE',
        ageMin: 21,
        ageMax: 27,
        enqueuedAt: Date.now(),
      };
      const start = performance.now();
      const matched = await engine.enqueue(probe);
      const elapsed = performance.now() - start;
      probeSamples.push(elapsed);

      if (matched) {
        // Re-insert consumed user so queue size and ratio remain steady across iterations.
        await engine.restoreUsers([matched.userB]);
      } else {
        await engine.dequeue(probe.userId);
      }
    }
    summarizeDurations(scenario.name, probeSamples);
  } finally {
    const keys = await redis.keys(`${ns}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
}

async function runConcurrentBurstScenario(redis: Redis, queueSize: number, burstCount: number): Promise<void> {
  const ns = `chatible:bench:burst:${crypto.randomUUID()}`;
  const engine = new MatchingEngine(redis, ns);
  try {
    await seedQueueDirectly(engine, queueSize, '0%');
    const latencies: number[] = [];
    const totalStart = performance.now();
    await Promise.all(
      Array.from({ length: burstCount }, async (_, i) => {
        const start = performance.now();
        await engine.enqueue({
          userId: `burst-user-${i}`,
          socketId: `burst-sock-${i}`,
          gender: 'MALE',
          age: 25,
          nickname: `Burst ${i}`,
          targetGender: 'FEMALE',
          ageMin: 21,
          ageMax: 27,
          enqueuedAt: Date.now(),
        });
        latencies.push(performance.now() - start);
      })
    );
    const totalMs = performance.now() - totalStart;
    summarizeDurations(
      `Concurrent burst (${burstCount} enqueues @ N=${queueSize}, 0% match) total=${totalMs.toFixed(1)}ms`,
      latencies
    );
  } finally {
    const keys = await redis.keys(`${ns}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
}

async function main() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true });
  await redis.connect();
  console.log('MatchingEngine Redis Benchmark');
  console.log('='.repeat(100));

  const scenarios: BenchmarkScenario[] = [
    { name: 'N=100, match=0% (worst-case miss)', queueSize: 100, matchRate: '0%', iterations: 25 },
    { name: 'N=500, match=0% (worst-case miss)', queueSize: 500, matchRate: '0%', iterations: 20 },
    { name: 'N=1500, match=0% (worst-case miss)', queueSize: 1500, matchRate: '0%', iterations: 15 },
    { name: 'N=3000, match=0% (worst-case miss)', queueSize: 3000, matchRate: '0%', iterations: 10 },
    { name: 'N=1500, match=10% (sparse hit)', queueSize: 1500, matchRate: '10%', iterations: 15 },
    { name: 'N=1500, match=50% (dense hit)', queueSize: 1500, matchRate: '50%', iterations: 15 },
    { name: 'N=1500, match=10%, blockCheck=2ms (simulated DB)', queueSize: 1500, matchRate: '10%', iterations: 10, withBlockCheckMs: 2 },
    { name: 'N=3000, match=10% (sparse hit)', queueSize: 3000, matchRate: '10%', iterations: 10 },
  ];

  for (const s of scenarios) {
    await runScenario(redis, s);
  }
  await runConcurrentBurstScenario(redis, 1500, 15);
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
