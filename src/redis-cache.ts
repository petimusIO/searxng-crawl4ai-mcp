import Redis from "ioredis";
import { skipTiming, timedAsync, timedSync } from "./search-timing.js";

const KEY_PREFIX = "mcp:cache:";
const DEFAULT_TTL_MS = 300_000; // 5 minutes

export class RedisCache {
  private client: Redis;
  private enabled: boolean;

  constructor(redisUrl?: string) {
    const url = redisUrl || process.env.REDIS_URL || "redis://localhost:6379";
    this.enabled = process.env.CACHE_ENABLED !== "false";
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null; // give up
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    // Suppress connection errors when cache is purely optional
    this.client.on("error", (err) => {
      // Log but don't crash — cache is best-effort
      if (this.enabled) {
        console.error("[RedisCache] Connection error:", err.message);
      }
    });
  }

  async get<T = any>(key: string): Promise<T | null> {
    if (!this.enabled) { skipTiming('mcp.cache.backend.get'); return null; }
    try {
      const raw = await timedAsync('mcp.cache.backend.get', () => this.client.get(`${KEY_PREFIX}${key}`), value => value ? 'hit' : 'miss');
      if (!raw) return null;
      return timedSync('mcp.cache.decode', () => JSON.parse(raw) as T);
    } catch {
      return null;
    }
  }

  async set(key: string, value: any, ttlMs?: number): Promise<void> {
    if (!this.enabled) { skipTiming('mcp.cache.backend.set'); return; }
    try {
      const serialized = timedSync('mcp.cache.serialization', () => JSON.stringify(value));
      const fullKey = `${KEY_PREFIX}${key}`;
      const ttl = (ttlMs ?? DEFAULT_TTL_MS) / 1000; // convert ms to seconds
      if (ttl > 0) {
        await timedAsync('mcp.cache.backend.set', () => this.client.setex(fullKey, Math.ceil(ttl), serialized));
      } else {
        await timedAsync('mcp.cache.backend.set', () => this.client.set(fullKey, serialized));
      }
    } catch {
      // best-effort
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(`${KEY_PREFIX}${key}`);
    } catch {
      // best-effort
    }
  }

  async flush(): Promise<void> {
    try {
      const keys = await this.client.keys(`${KEY_PREFIX}*`);
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } catch {
      // best-effort
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // best-effort
    }
  }
}
