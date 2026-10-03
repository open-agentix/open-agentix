import { LRUCache } from 'lru-cache';

/**
 * Cache-aside layer. In-memory LRU by default; Valkey/Redis (OAX_CACHE_URL) shares entries and
 * invalidations across replicas. Authorization results are never cached longer than the token TTL.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  delPrefix(prefix: string): Promise<void>;
  close(): Promise<void>;
}

export class MemoryCache implements Cache {
  private readonly lru: LRUCache<string, { v: unknown }>;

  constructor(maxEntries = 10_000) {
    this.lru = new LRUCache({ max: maxEntries, ttlAutopurge: false });
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.lru.get(key)?.v as T | undefined;
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    this.lru.set(key, { v: value }, { ttl: ttlMs });
  }

  async del(key: string): Promise<void> {
    this.lru.delete(key);
  }

  async delPrefix(prefix: string): Promise<void> {
    for (const k of [...this.lru.keys()]) if (k.startsWith(prefix)) this.lru.delete(k);
  }

  async close(): Promise<void> {
    this.lru.clear();
  }
}

/** Minimal client surface (iovalkey / ioredis compatible). */
export interface ValkeyLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    n: number,
  ): Promise<[string, string[]]>;
  quit(): Promise<unknown>;
}

export class ValkeyCache implements Cache {
  constructor(
    private readonly client: ValkeyLike,
    private readonly namespace = 'oax:',
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.namespace + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    await this.client.set(this.namespace + key, JSON.stringify(value), 'PX', Math.ceil(ttlMs));
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.namespace + key);
  }

  async delPrefix(prefix: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(
        cursor,
        'MATCH',
        `${this.namespace}${prefix}*`,
        'COUNT',
        500,
      );
      if (keys.length) await this.client.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export async function createCache(url: string | undefined, maxEntries: number): Promise<Cache> {
  if (!url) return new MemoryCache(maxEntries);
  const { Valkey } = await import('iovalkey');
  return new ValkeyCache(
    new Valkey(url, { lazyConnect: false, maxRetriesPerRequest: 2 }) as unknown as ValkeyLike,
  );
}

/** cache-aside helper: returns the cached value or loads, stores and returns it. */
export async function cached<T>(
  cache: Cache,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== undefined) return hit;
  const value = await load();
  if (value !== undefined && value !== null) await cache.set(key, value, ttlMs);
  return value;
}
