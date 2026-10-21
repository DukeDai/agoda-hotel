/**
 * Cache and distributed lock ports.
 *
 * Redis is the production implementation. The in-memory implementation is a
 * development fallback so the system boots without a Redis server; it is
 * explicitly NOT safe for multiple API instances.
 */
import Redis from 'ioredis';

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete by prefix. Used to invalidate a hotel's cached availability. */
  deleteByPrefix(prefix: string): Promise<void>;
}

export interface LockHandle {
  release(): Promise<void>;
}

export interface Lock {
  /** Returns null when the lock is already held by someone else. */
  acquire(key: string, ttlMs?: number): Promise<LockHandle | null>;
  withLock<T>(key: string, fn: () => Promise<T>, ttlMs?: number): Promise<T>;
}

export interface CacheBundle {
  cache: Cache;
  lock: Lock;
  kind: 'redis' | 'memory';
}

// --- In-memory (dev fallback) ----------------------------------------------

class MemoryCache implements Cache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt > 0 && hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    try {
      return JSON.parse(hit.value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = 120): Promise<void> {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

class MemoryLock implements Lock {
  private readonly held = new Map<string, number>();

  async acquire(key: string, ttlMs = 10_000): Promise<LockHandle | null> {
    const now = Date.now();
    const expires = this.held.get(key);
    if (expires !== undefined && expires > now) return null;
    this.held.set(key, now + ttlMs);
    return {
      release: async () => {
        this.held.delete(key);
      },
    };
  }

  async withLock<T>(key: string, fn: () => Promise<T>, ttlMs = 10_000): Promise<T> {
    const handle = await this.acquire(key, ttlMs);
    if (!handle) throw new Error(`Lock "${key}" is already held`);
    try {
      return await fn();
    } finally {
      await handle.release();
    }
  }
}

// --- Redis -----------------------------------------------------------------

export function createRedisBundle(url: string): CacheBundle {
  const client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });

  const cache: Cache = {
    async get<T>(key: string): Promise<T | null> {
      const raw = await client.get(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async set<T>(key: string, value: T, ttlSeconds = 120): Promise<void> {
      const payload = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await client.set(key, payload, 'EX', ttlSeconds);
      } else {
        await client.set(key, payload);
      }
    },
    async delete(key: string): Promise<void> {
      await client.del(key);
    },
    async deleteByPrefix(prefix: string): Promise<void> {
      // SCAN, never KEYS: KEYS blocks the Redis event loop.
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await client.del(...keys);
      } while (cursor !== '0');
    },
  };

  const lock: Lock = {
    async acquire(key: string, ttlMs = 10_000): Promise<LockHandle | null> {
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ok = await client.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
      if (ok !== 'OK') return null;
      return {
        release: async () => {
          // Only release if we still own it.
          await client.eval(
            `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
            1,
            `lock:${key}`,
            token,
          );
        },
      };
    },
    async withLock<T>(key: string, fn: () => Promise<T>, ttlMs = 10_000): Promise<T> {
      const handle = await lock.acquire(key, ttlMs);
      if (!handle) throw new Error(`Lock "${key}" is already held`);
      try {
        return await fn();
      } finally {
        await handle.release();
      }
    },
  };

  return { cache, lock, kind: 'redis' };
}
export function createMemoryBundle(): CacheBundle {
  return { cache: new MemoryCache(), lock: new MemoryLock(), kind: 'memory' };
}

export function createCacheBundle(redisUrl: string | undefined): CacheBundle {
  return redisUrl ? createRedisBundle(redisUrl) : createMemoryBundle();
}
