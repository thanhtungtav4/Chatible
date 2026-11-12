import crypto from 'node:crypto';
import type Redis from 'ioredis';

export interface VideoWatermarkJob {
  mediaId: string;
  recipientId: string;
}

export interface VideoWorkerHeartbeatInfo {
  workerId: string;
  pid: number;
  ffmpegOk: boolean;
  concurrency: number;
  updatedAtMs: number;
}

export interface VideoWorkerHealthReport {
  healthy: boolean;
  liveWorkers: number;
  ffmpegOk: boolean;
  workers: VideoWorkerHeartbeatInfo[];
}

export interface VideoWatermarkQueue {
  enqueue(job: VideoWatermarkJob): Promise<void>;
  isHealthy?(staleAfterMs?: number): Promise<boolean>;
  getWorkerHealth?(staleAfterMs?: number): Promise<VideoWorkerHealthReport>;
}

const VIDEO_QUEUE_KEY = 'queue:media:video:jobs';
const VIDEO_SEM_KEY = 'sem:media:video:active';
const VIDEO_WORKERS_ZSET_KEY = 'health:media:workers';
const VIDEO_WORKER_INFO_PREFIX = 'health:media:worker:';

const ACQUIRE_SLOT_LUA = `
local semKey = KEYS[1]
local lockId = ARGV[1]
local maxConc = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', semKey, '-inf', nowMs - ttlMs)
if redis.call('ZCARD', semKey) >= maxConc then
  return 0
end
redis.call('ZADD', semKey, nowMs, lockId)
redis.call('PEXPIRE', semKey, ttlMs)
return 1
`;

export class RedisVideoWatermarkQueue implements VideoWatermarkQueue {
  readonly maxConcurrency: number;
  readonly lockTtlMs: number;

  constructor(
    private readonly redis: Redis,
    options: { maxConcurrency?: number; lockTtlMs?: number } = {}
  ) {
    this.maxConcurrency = Math.max(
      1,
      options.maxConcurrency ?? Number.parseInt(process.env.MEDIA_WORKER_CONCURRENCY || '1', 10)
    );
    this.lockTtlMs = Math.max(15_000, options.lockTtlMs ?? 90_000);
  }

  async enqueue(job: VideoWatermarkJob): Promise<void> {
    const dedupKey = `queue:media:video:dedup:${job.mediaId}:${job.recipientId}`;
    const locked = await this.redis.set(dedupKey, '1', 'EX', 120, 'NX');
    if (locked !== 'OK') {
      return;
    }
    await this.redis.lpush(VIDEO_QUEUE_KEY, JSON.stringify(job));
  }

  async clearDedup(job: VideoWatermarkJob): Promise<void> {
    await this.redis.del(`queue:media:video:dedup:${job.mediaId}:${job.recipientId}`).catch(() => {});
  }

  async popBlocking(blockingRedis: Redis, timeoutSec = 2): Promise<VideoWatermarkJob | null> {
    const res = await blockingRedis.brpop(VIDEO_QUEUE_KEY, timeoutSec);
    if (!res || !res[1]) return null;
    try {
      const parsed = JSON.parse(res[1]) as VideoWatermarkJob;
      if (parsed?.mediaId && parsed?.recipientId) return parsed;
    } catch {
      // ignore malformed payload
    }
    return null;
  }

  async requeue(job: VideoWatermarkJob): Promise<void> {
    await this.redis.lpush(VIDEO_QUEUE_KEY, JSON.stringify(job));
  }

  async acquireSlot(): Promise<string | null> {
    const lockId = crypto.randomBytes(12).toString('hex');
    const acquired = await this.redis.eval(
      ACQUIRE_SLOT_LUA,
      1,
      VIDEO_SEM_KEY,
      lockId,
      String(this.maxConcurrency),
      String(this.lockTtlMs),
      String(Date.now())
    );
    return Number(acquired) === 1 ? lockId : null;
  }

  async releaseSlot(lockId: string): Promise<void> {
    if (!lockId) return;
    await this.redis.zrem(VIDEO_SEM_KEY, lockId).catch(() => {});
  }

  async getActiveCount(): Promise<number> {
    await this.redis.zremrangebyscore(VIDEO_SEM_KEY, '-inf', Date.now() - this.lockTtlMs);
    return this.redis.zcard(VIDEO_SEM_KEY);
  }

  async publishHeartbeat(
    workerId: string,
    info: { pid: number; ffmpegOk: boolean; concurrency?: number },
    ttlMs = 20_000
  ): Promise<void> {
    const nowMs = Date.now();
    const payload: VideoWorkerHeartbeatInfo = {
      workerId,
      pid: info.pid,
      ffmpegOk: info.ffmpegOk,
      concurrency: info.concurrency ?? this.maxConcurrency,
      updatedAtMs: nowMs,
    };
    const infoKey = `${VIDEO_WORKER_INFO_PREFIX}${workerId}`;
    await this.redis
      .multi()
      .set(infoKey, JSON.stringify(payload), 'PX', Math.max(5_000, ttlMs))
      .zadd(VIDEO_WORKERS_ZSET_KEY, nowMs, workerId)
      .zremrangebyscore(VIDEO_WORKERS_ZSET_KEY, '-inf', nowMs - ttlMs)
      .pexpire(VIDEO_WORKERS_ZSET_KEY, Math.max(10_000, ttlMs * 2))
      .exec();
  }

  async clearHeartbeat(workerId: string): Promise<void> {
    if (!workerId) return;
    await this.redis
      .multi()
      .del(`${VIDEO_WORKER_INFO_PREFIX}${workerId}`)
      .zrem(VIDEO_WORKERS_ZSET_KEY, workerId)
      .exec()
      .catch(() => {});
  }

  async getWorkerHealth(staleAfterMs = 15_000): Promise<VideoWorkerHealthReport> {
    const cutoff = Date.now() - Math.max(3_000, staleAfterMs);
    await this.redis.zremrangebyscore(VIDEO_WORKERS_ZSET_KEY, '-inf', cutoff);
    const workerIds = await this.redis.zrangebyscore(VIDEO_WORKERS_ZSET_KEY, cutoff, '+inf');
    if (workerIds.length === 0) {
      return { healthy: false, liveWorkers: 0, ffmpegOk: false, workers: [] };
    }
    const rawEntries = await this.redis.mget(...workerIds.map((id) => `${VIDEO_WORKER_INFO_PREFIX}${id}`));
    const workers: VideoWorkerHeartbeatInfo[] = [];
    for (const raw of rawEntries) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as VideoWorkerHeartbeatInfo;
        if (parsed && parsed.updatedAtMs >= cutoff) {
          workers.push(parsed);
        }
      } catch {
        // ignore malformed heartbeat payload
      }
    }
    const ffmpegOk = workers.some((w) => w.ffmpegOk === true);
    return {
      healthy: workers.length > 0 && ffmpegOk,
      liveWorkers: workers.length,
      ffmpegOk,
      workers,
    };
  }

  async isHealthy(staleAfterMs = 15_000): Promise<boolean> {
    try {
      const report = await this.getWorkerHealth(staleAfterMs);
      return report.healthy;
    } catch {
      return false;
    }
  }
}
