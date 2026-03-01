// file: src/cache.ts
// description: cache service for cloudflare workers with ttl support
// reference: internal

import { Context, Effect, Layer, Option } from 'effect';
import { UpstreamError } from './errors';

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl: number;
}

// In-memory cache fallback with TTL cleanup and size limits.
class InMemoryCache {
  private store = new Map<string, { response: Response, expiry: number }>();
  private maxSize = 100; // Limit cache size

  async match(request: Request): Promise<Response | undefined> {
    const entry = this.store.get(request.url);
    if (!entry) return undefined;

    // Check expiry
    if (Date.now() > entry.expiry) {
      this.store.delete(request.url);
      return undefined;
    }

    return entry.response.clone(); // Clone to prevent mutation
  }

  async put(request: Request, response: Response): Promise<void> {
    // Evict oldest entries if at capacity
    if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    // Extract TTL from cache-control header
    const cacheControl = response.headers.get('Cache-Control') || '';
    const maxAge = parseInt(cacheControl.match(/max-age=(\d+)/)?.[1] || '600');

    this.store.set(request.url, { response: response.clone(), expiry: Date.now() + (maxAge * 1000) });
  }

  async delete(request: Request): Promise<boolean> {
    return this.store.delete(request.url);
  }
}

const getCacheInstance = (): Cache => {
  if (typeof caches !== 'undefined' && caches.default) {
    return caches.default;
  }
  return new InMemoryCache() as unknown as Cache;
};

export class CacheService
  extends Context.Tag('CacheService')<
    CacheService,
    {
      readonly get: <T>(key: string) => Effect.Effect<Option.Option<T>, UpstreamError>,
      readonly set: <T>(key: string, value: T, ttl?: number) => Effect.Effect<void, UpstreamError>,
      readonly delete: (key: string) => Effect.Effect<void, UpstreamError>
    }
  >() {}

export const CacheServiceLive = (defaultTtl: number) =>
  Layer.succeed(
    CacheService,
    CacheService.of({
      get: <T>(key: string) =>
        Effect.tryPromise({
          try: async () => {
            const cache = getCacheInstance();
            const response = await cache.match(new Request(`https://cache/${key}`));

            if (!response) {
              return Option.none<T>();
            }

            const entry = await response.json<CacheEntry<T>>();
            const now = Date.now() / 1000;

            if (now > entry.timestamp + entry.ttl) {
              return Option.none<T>();
            }

            return Option.some(entry.value);
          },
          catch: (error) => new UpstreamError({ message: `Cache get error: ${String(error)}`, retryable: true })
        }),

      set: <T>(key: string, value: T, ttl?: number) =>
        Effect.tryPromise({
          try: async () => {
            const cache = getCacheInstance();
            const entryTtl = ttl || defaultTtl;

            const entry: CacheEntry<T> = { value, timestamp: Date.now() / 1000, ttl: entryTtl };

            const response = new Response(JSON.stringify(entry), {
              headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${entryTtl}` }
            });

            await cache.put(new Request(`https://cache/${key}`), response);
          },
          catch: (error) => new UpstreamError({ message: `Cache set error: ${String(error)}`, retryable: true })
        }).pipe(Effect.asVoid),

      delete: (key: string) =>
        Effect.tryPromise({
          try: async () => {
            const cache = getCacheInstance();
            await cache.delete(new Request(`https://cache/${key}`));
          },
          catch: (error) => new UpstreamError({ message: `Cache delete error: ${String(error)}`, retryable: true })
        }).pipe(Effect.asVoid)
    })
  );
