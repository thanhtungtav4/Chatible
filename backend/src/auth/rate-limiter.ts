import crypto from 'node:crypto';
import type Redis from 'ioredis';

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local maxReq = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= maxReq then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return 1
`;

/**
 * In-memory sliding-window fallback (used only in isolated unit tests without Redis)
 */
export class MemoryRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  check(key: string, now: number = Date.now()): boolean {
    const timestamps = this.windows.get(key) || [];
    const threshold = now - this.windowMs;
    const validTimestamps = timestamps.filter((t) => t > threshold);

    if (validTimestamps.length >= this.maxRequests) {
      this.windows.set(key, validTimestamps);
      return false;
    }

    validTimestamps.push(now);
    this.windows.set(key, validTimestamps);
    return true;
  }

  reset(key?: string): void {
    if (key) this.windows.delete(key);
    else this.windows.clear();
  }
}

/**
 * Production multi-node sliding-window rate limiter backed by atomic Redis Lua ZSETs,
 * with fallback to local memory only if no Redis client is provided.
 */
export class DistributedRateLimiter {
  private readonly fallback: MemoryRateLimiter;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly prefix: string = 'rl',
    private redis?: Redis
  ) {
    this.fallback = new MemoryRateLimiter(maxRequests, windowMs);
  }

  setRedis(redis: Redis): void {
    this.redis = redis;
  }

  async check(key: string, now: number = Date.now()): Promise<boolean> {
    if (this.redis) {
      const redisKey = `${this.prefix}:${key}`;
      const member = `${now}:${crypto.randomBytes(6).toString('hex')}`;
      try {
        const res = await this.redis.eval(
          SLIDING_WINDOW_LUA,
          1,
          redisKey,
          String(now),
          String(this.windowMs),
          String(this.maxRequests),
          member
        );
        return Number(res) === 1;
      } catch (err) {
        if (process.env.NODE_ENV === 'production') {
          console.error('[RateLimiter] Redis eval failed in production:', err);
          return false; // Fail closed in production when distributed limiter errors
        }
      }
    }
    return this.fallback.check(key, now);
  }

  async reset(key?: string): Promise<void> {
    this.fallback.reset(key);
    if (this.redis && key) {
      await this.redis.del(`${this.prefix}:${key}`).catch(() => {});
    }
  }
}
