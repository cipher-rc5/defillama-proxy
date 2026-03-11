# Directory Structure
```
src/
  api.ts
  cache.ts
  config.ts
  errors.ts
  handler.ts
  index.ts
  rate-limiter.ts
  schema.ts
```

# Files

## File: src/cache.ts
```typescript
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
```

## File: src/rate-limiter.ts
```typescript
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitRequest {
  key: string;
  windowMs: number;
  maxRequests: number;
}

interface RateLimitResponse {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  limit: number;
}

const makeJson = (payload: RateLimitResponse): Response => {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
};

export class RateLimiterDurableObject {
  constructor (private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let payload: RateLimitRequest;
    try {
      payload = (await request.json()) as RateLimitRequest;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const now = Date.now();
    const key = `rate:${payload.key}`;
    const current = (await this.state.storage.get<RateLimitEntry>(key)) ?? null;

    let entry: RateLimitEntry;
    if (!current || now >= current.resetAt) {
      entry = { count: 1, resetAt: now + payload.windowMs };
    } else {
      entry = { count: current.count + 1, resetAt: current.resetAt };
    }

    await this.state.storage.put(key, entry);

    const allowed = entry.count <= payload.maxRequests;
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    const remaining = allowed ? Math.max(0, payload.maxRequests - entry.count) : 0;

    return makeJson({ allowed, retryAfterSeconds, remaining, limit: payload.maxRequests });
  }
}
```

## File: src/config.ts
```typescript
// file: src/config.ts
// description: application configuration service with environment variable loading
// reference: internal

import { Config, Context, Effect, Layer } from 'effect';

// 1. Define AppConfig as a service using Context.Tag
export class AppConfig
  extends Context.Tag('AppConfig')<
    AppConfig,
    {
      readonly cacheTtl: number,
      readonly apiTimeout: number,
      readonly retryInitialInterval: number,
      readonly retryMaxAttempts: number,
      readonly maxConcurrentRequests: number,
      readonly supportedProtocols: ReadonlySet<string>
    }
  >() {}

// Helper to load supported protocols from CSV
const loadSupportedProtocols = (): Effect.Effect<ReadonlySet<string>> =>
  Effect.succeed(
    new Set([
      'aave',
      'uniswap',
      'compound',
      'makerdao',
      'curve',
      '9inch',
      '9mm',
      'edge',
      'a51-finance',
      'abracadabra',
      'accumulated-finance',
      'adrastea',
      'aera',
      'aerodrome',
      'aevo',
      'affine-defi',
      'aftermath-finance'
    ])
  );

// 2. Create a "Live" Layer using Layer.effect with Config service
export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.gen(function*() {
    // Load configuration values using Config service
    const cacheTtl = yield* Config.number('CACHE_TTL').pipe(Config.withDefault(600));
    const apiTimeout = yield* Config.number('API_TIMEOUT').pipe(Config.withDefault(5000));
    const retryInitialInterval = yield* Config.number('RETRY_INITIAL_MS').pipe(Config.withDefault(500));
    const retryMaxAttempts = yield* Config.number('RETRY_MAX_ATTEMPTS').pipe(Config.withDefault(3));
    const maxConcurrentRequests = yield* Config.number('MAX_CONCURRENT_REQUESTS').pipe(Config.withDefault(10));

    // Load supported protocols
    const supportedProtocols = yield* loadSupportedProtocols();

    return AppConfig.of({
      cacheTtl,
      apiTimeout,
      retryInitialInterval,
      retryMaxAttempts,
      maxConcurrentRequests,
      supportedProtocols
    });
  })
);

// Alternative: Direct environment variable access for Cloudflare Workers
export const AppConfigFromEnv = (
  env: {
    CACHE_TTL?: string,
    API_TIMEOUT?: string,
    RETRY_INITIAL_MS?: string,
    RETRY_MAX_ATTEMPTS?: string,
    MAX_CONCURRENT_REQUESTS?: string
  }
) =>
  Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const cacheTtl = parseInt(env.CACHE_TTL || '600', 10);
      const apiTimeout = parseInt(env.API_TIMEOUT || '5000', 10);
      const retryInitialInterval = parseInt(env.RETRY_INITIAL_MS || '500', 10);
      const retryMaxAttempts = parseInt(env.RETRY_MAX_ATTEMPTS || '3', 10);
      const maxConcurrentRequests = parseInt(env.MAX_CONCURRENT_REQUESTS || '10', 10);

      const supportedProtocols = yield* loadSupportedProtocols();

      return AppConfig.of({
        cacheTtl,
        apiTimeout,
        retryInitialInterval,
        retryMaxAttempts,
        maxConcurrentRequests,
        supportedProtocols
      });
    })
  );
```

## File: src/errors.ts
```typescript
// file: src/errors.ts
// description: custom error types for the application
// reference: internal

import { Data } from 'effect';

// API error for HTTP-related failures
export class ApiError extends Data.TaggedError('ApiError')<{ message: string, statusCode: number }> {}

// Error when requested protocol doesn't exist
export class InvalidProtocolError extends Data.TaggedError('InvalidProtocolError')<{ protocol: string }> {}

// Error when requested chain doesn't exist for a protocol
export class ChainNotFoundError
  extends Data.TaggedError('ChainNotFoundError')<{ protocol: string, chain: string, availableChains: string[] }> {}

// Upstream service error with retry capability
export class UpstreamError extends Data.TaggedError('UpstreamError')<{ message: string, retryable: boolean }> {}

// Error parsing or validating data
export class ParseError
  extends Data.TaggedError('ParseError')<
    { message: string, source: 'query' | 'cache' | 'upstream', cause?: unknown }
  > {}
```

## File: src/api.ts
```typescript
// file: src/api.ts
// description: defillama api client service with retry logic and error handling
// reference: internal

import { HttpClient, HttpClientRequest } from '@effect/platform';
import { Context, Duration, Effect, Layer, pipe, Schedule, Schema } from 'effect';
import { ApiError, InvalidProtocolError, UpstreamError } from './errors';
import { ProtocolData } from './schema';

const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30000;

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

const isCircuitOpen = (): boolean => Date.now() < circuitOpenUntil;

const registerFailure = (): void => {
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
  }
};

const registerSuccess = (): void => {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
};

// 1. Define the service interface using Context.Tag
export class DeFiLlamaClient
  extends Context.Tag('DeFiLlamaClient')<
    DeFiLlamaClient,
    {
      readonly fetchProtocol: (
        protocol: string
      ) => Effect.Effect<ProtocolData, ApiError | InvalidProtocolError | UpstreamError, never>
    }
  >() {}

// 2. Create a "Live" Layer that provides the actual implementation
export const DeFiLlamaClientLive = (timeout: number) =>
  Layer.effect(
    DeFiLlamaClient,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient;

      return DeFiLlamaClient.of({
        fetchProtocol: (
          protocol: string
        ): Effect.Effect<ProtocolData, ApiError | InvalidProtocolError | UpstreamError, never> => {
          if (isCircuitOpen()) {
            return Effect.fail(
              new UpstreamError({ message: 'Upstream circuit breaker is open; retry shortly', retryable: false })
            );
          }

          const url = `https://api.llama.fi/protocol/${encodeURIComponent(protocol)}`;

          return pipe(
            HttpClientRequest.get(url),
            HttpClientRequest.setHeader('User-Agent', 'defillama-proxy/1.0'),
            HttpClientRequest.setHeader('Accept', 'application/json'),
            client.execute,
            Effect.flatMap((response) => {
              // Handle 404 - protocol not found
              if (response.status === 404) {
                return Effect.fail(new InvalidProtocolError({ protocol })) as Effect.Effect<
                  ProtocolData,
                  InvalidProtocolError | ApiError,
                  never
                >;
              }

              // Handle other non-2xx responses
              if (response.status < 200 || response.status >= 300) {
                return pipe(
                  response.text,
                  Effect.catchAll(() => Effect.succeed('Unable to read response body')),
                  Effect.flatMap(errorText =>
                    Effect.fail(
                      new ApiError({
                        message: `API returned ${response.status}: ${errorText}`,
                        statusCode: response.status
                      })
                    )
                  )
                ) as Effect.Effect<ProtocolData, ApiError | InvalidProtocolError, never>;
              }

              // Parse and validate successful response
              return pipe(
                response.json,
                Effect.catchAll((error) =>
                  Effect.fail(new ApiError({ message: `Failed to parse JSON: ${error}`, statusCode: 200 }))
                ),
                Effect.flatMap(json =>
                  Schema.decodeUnknown(ProtocolData)(json).pipe(
                    Effect.mapError((parseError) =>
                      new ApiError({
                        message: `Failed to validate protocol data: ${String(parseError)}`,
                        statusCode: 200
                      })
                    )
                  )
                )
              ) as Effect.Effect<ProtocolData, ApiError | InvalidProtocolError, never>;
            }),
            Effect.scoped,
            // Handle timeout
            Effect.timeoutFail({
              duration: Duration.millis(timeout),
              onTimeout: () => new UpstreamError({ message: `Request timeout after ${timeout}ms`, retryable: true })
            }),
            // Retry strategy with exponential backoff and jitter
            Effect.retry({
              schedule: pipe(
                Schedule.exponential(Duration.millis(500)),
                Schedule.jittered,
                Schedule.compose(Schedule.recurs(3))
              ),
              while: (error) => error instanceof UpstreamError && error.retryable
            }),
            // Add tracing
            Effect.withSpan('fetchProtocol', { attributes: { protocol } }),
            Effect.tap(() => Effect.sync(registerSuccess)),
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (!(error instanceof InvalidProtocolError)) {
                  registerFailure();
                }
              })
            ),
            // Map any HttpClientError to UpstreamError to match our return type signature
            Effect.mapError(error => {
              if (
                error instanceof ApiError || error instanceof InvalidProtocolError || error instanceof UpstreamError
              ) {
                return error;
              }
              // Convert any other errors (like HttpClientError) to UpstreamError
              return new UpstreamError({ message: `Network error: ${String(error)}`, retryable: true });
            })
          );
        }
      });
    })
  );
```

## File: src/handler.ts
```typescript
// file: src/handler.ts
// description: request handlers for tvl and chains endpoints
// reference: internal

import { Effect, Option, Schema } from 'effect';
import { DeFiLlamaClient } from './api';
import { CacheService } from './cache';
import { ApiError, ChainNotFoundError, InvalidProtocolError, UpstreamError } from './errors';
import { ChainsResponse, ProtocolData, QueryParams, TvlResponse } from './schema';

const resolveChainKey = (
  chainTvls: Record<
    string,
    { readonly tvl: ReadonlyArray<{ readonly date: number, readonly totalLiquidityUSD: number }> }
  >,
  chain: string
) => {
  if (chainTvls[chain]) return chain;
  const requested = chain.toLowerCase();
  return Object.keys(chainTvls).find(candidate => candidate.toLowerCase() === requested);
};

// Cache full protocol data and filter at query time.
export const handleTvl = (
  protocol: string,
  chain: string,
  params: QueryParams
): Effect.Effect<
  TvlResponse,
  ChainNotFoundError | ApiError | InvalidProtocolError | UpstreamError,
  DeFiLlamaClient | CacheService
> =>
  Effect.gen(function*() {
    const client = yield* DeFiLlamaClient;
    const cache = yield* CacheService;
    const normalizedProtocol = protocol.trim().toLowerCase();

    // Cache at protocol level to reuse across queries.
    const cacheKey = `protocol:${normalizedProtocol}`;

    // Check cache for full protocol data
    const cached = yield* cache.get<ProtocolData>(cacheKey);

    let data: ProtocolData;
    if (Option.isSome(cached)) {
      yield* Effect.log(`Cache hit: ${cacheKey}`);
      const decoded = yield* Schema.decodeUnknown(ProtocolData)(cached.value).pipe(
        Effect.map(Option.some),
        Effect.catchAll(() =>
          Effect.gen(function*() {
            yield* Effect.log(`Cache entry invalid for ${cacheKey}; refetching`);
            yield* cache.delete(cacheKey);
            return Option.none<ProtocolData>();
          })
        )
      );

      if (Option.isSome(decoded)) {
        data = decoded.value;
      } else {
        data = yield* client.fetchProtocol(normalizedProtocol);
        yield* cache.set(cacheKey, data, 600);
      }
    } else {
      yield* Effect.log(`Cache miss: ${cacheKey}`);
      data = yield* client.fetchProtocol(normalizedProtocol);
      // Cache the full protocol data
      yield* cache.set(cacheKey, data, 600);
    }

    const resolvedChain = resolveChainKey(data.chainTvls, chain);

    // Check if chain exists
    if (!resolvedChain) {
      return yield* Effect.fail(
        new ChainNotFoundError({ protocol, chain, availableChains: Object.keys(data.chainTvls) })
      );
    }

    // Process TVL data with filtering
    let tvl = [...data.chainTvls[resolvedChain].tvl].sort((a, b) => a.date - b.date);

    // Apply filters
    if (params.days > 0) {
      const cutoff = Date.now() / 1000 - (params.days * 24 * 60 * 60);
      tvl = tvl.filter(entry => entry.date >= cutoff);
    }

    if (params.limit > 0) {
      tvl = tvl.slice(-params.limit);
    }

    return new TvlResponse({
      protocol: normalizedProtocol,
      chain: resolvedChain,
      query: {
        days: params.days === 0 ? 'all' as const : params.days,
        limit: params.limit === 0 ? 'all' as const : params.limit
      },
      count: tvl.length,
      tvl
    });
  });

export const handleChains = (
  protocol: string
): Effect.Effect<ChainsResponse, ApiError | InvalidProtocolError | UpstreamError, DeFiLlamaClient | CacheService> =>
  Effect.gen(function*() {
    const client = yield* DeFiLlamaClient;
    const cache = yield* CacheService;
    const normalizedProtocol = protocol.trim().toLowerCase();

    // Reuse same cache key pattern
    const cacheKey = `protocol:${normalizedProtocol}`;

    const cached = yield* cache.get<ProtocolData>(cacheKey);

    let data: ProtocolData;
    if (Option.isSome(cached)) {
      yield* Effect.log(`Cache hit: ${cacheKey}`);
      const decoded = yield* Schema.decodeUnknown(ProtocolData)(cached.value).pipe(
        Effect.map(Option.some),
        Effect.catchAll(() =>
          Effect.gen(function*() {
            yield* Effect.log(`Cache entry invalid for ${cacheKey}; refetching`);
            yield* cache.delete(cacheKey);
            return Option.none<ProtocolData>();
          })
        )
      );

      if (Option.isSome(decoded)) {
        data = decoded.value;
      } else {
        data = yield* client.fetchProtocol(normalizedProtocol);
        yield* cache.set(cacheKey, data, 3600);
      }
    } else {
      yield* Effect.log(`Cache miss: ${cacheKey}`);
      data = yield* client.fetchProtocol(normalizedProtocol);
      yield* cache.set(cacheKey, data, 3600);
    }

    return new ChainsResponse({ protocol: normalizedProtocol, chains: Object.keys(data.chainTvls) });
  });
```

## File: src/schema.ts
```typescript
// file: src/schema.ts
// description: data schemas for api requests and responses
// reference: internal

import { Schema } from 'effect';

// TVL data entry schema
export const TvlEntry = Schema.Struct({ date: Schema.Number, totalLiquidityUSD: Schema.Number });
export type TvlEntry = Schema.Schema.Type<typeof TvlEntry>;

// Chain TVL data schema
export class ChainTvl extends Schema.Class<ChainTvl>('ChainTvl')({ tvl: Schema.Array(TvlEntry) }) {}

// Protocol data schema from DeFiLlama API
export class ProtocolData
  extends Schema.Class<ProtocolData>('ProtocolData')({
    chainTvls: Schema.Record({ key: Schema.String, value: ChainTvl })
  }) {}

// Query parameters for TVL endpoint
export class QueryParams
  extends Schema.Class<QueryParams>('QueryParams')({
    days: Schema.optionalWith(
      Schema.NumberFromString.pipe(Schema.int(), Schema.nonNegative(), Schema.lessThanOrEqualTo(3650)),
      { default: () => 30 }
    ),
    limit: Schema.optionalWith(
      Schema.NumberFromString.pipe(Schema.int(), Schema.nonNegative(), Schema.lessThanOrEqualTo(5000)),
      { default: () => 0 }
    )
  }) {}

// TVL API response schema
export class TvlResponse
  extends Schema.Class<TvlResponse>('TvlResponse')({
    protocol: Schema.String,
    chain: Schema.String,
    query: Schema.Struct({
      days: Schema.Union(Schema.Number, Schema.Literal('all')),
      limit: Schema.Union(Schema.Number, Schema.Literal('all'))
    }),
    count: Schema.Number,
    tvl: Schema.Array(TvlEntry)
  }) {}

// Chains API response schema
export class ChainsResponse
  extends Schema.Class<ChainsResponse>('ChainsResponse')({
    protocol: Schema.String,
    chains: Schema.Array(Schema.String)
  }) {}
```

## File: src/index.ts
```typescript
// file: src/index.ts
// description: main application entry point with hono server and Effect integration
// reference: internal

import { FetchHttpClient } from '@effect/platform';
import { Cause, Effect, Exit, Layer, Schema } from 'effect';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { DeFiLlamaClient, DeFiLlamaClientLive } from './api';
import { CacheService, CacheServiceLive } from './cache';
import { ParseError } from './errors';
import { handleChains, handleTvl } from './handler';
import { RateLimiterDurableObject } from './rate-limiter';
import { QueryParams } from './schema';

interface Bindings {
  CACHE_TTL?: string;
  API_TIMEOUT?: string;
  RATE_LIMIT_WINDOW_MS?: string;
  RATE_LIMIT_MAX?: string;
  CORS_ORIGINS?: string;
  RATE_LIMITER?: DurableObjectNamespace;
  caches?: { default: Cache };
}

interface Variables {
  requestId: string;
}

const app = new Hono<{ Bindings: Bindings, Variables: Variables }>();

const parseBoundedInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const parseCorsOrigins = (originsValue: string | undefined): string[] => {
  if (!originsValue) return [];
  return originsValue.split(',').map(origin => origin.trim()).filter(Boolean);
};

const localRateLimitStore = new Map<string, { count: number, resetAt: number }>();

const fallbackRateLimitCheck = (
  key: string,
  now: number,
  windowMs: number,
  maxRequests: number
): { allowed: boolean, retryAfterSeconds: number } => {
  const current = localRateLimitStore.get(key);
  if (!current || now >= current.resetAt) {
    localRateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (current.count >= maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }

  current.count += 1;
  localRateLimitStore.set(key, current);
  return { allowed: true, retryAfterSeconds: 0 };
};

const logError = (label: string, requestId: string, details: Record<string, unknown>): void => {
  console.error(label, { requestId, ...details });
};

app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  const startedAt = Date.now();

  await next();

  c.header('x-request-id', requestId);
  c.header('x-content-type-options', 'nosniff');
  c.header('x-frame-options', 'DENY');
  c.header('referrer-policy', 'no-referrer');
  c.header('permissions-policy', 'geolocation=()');
  c.header('x-response-time-ms', String(Date.now() - startedAt));
});

app.use('*', (c, next) => {
  const env = c.env ?? {};
  const configuredOrigins = parseCorsOrigins(env.CORS_ORIGINS);
  const corsMiddleware = cors({
    origin: (requestOrigin) => {
      if (configuredOrigins.length === 0) return '*';
      if (!requestOrigin) return configuredOrigins[0] ?? '*';
      return configuredOrigins.includes(requestOrigin) ? requestOrigin : '';
    },
    allowMethods: ['GET', 'OPTIONS'],
    maxAge: 86400
  });

  return corsMiddleware(c, next);
});

app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return next();
  }

  const env = c.env ?? {};
  const windowMs = parseBoundedInt(env.RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000);
  const maxRequests = parseBoundedInt(env.RATE_LIMIT_MAX, 120, 1, 10000);
  const now = Date.now();
  const forwardedFor = c.req.header('x-forwarded-for');
  const ip = c.req.header('cf-connecting-ip') ?? forwardedFor?.split(',')[0]?.trim() ?? 'unknown';
  const key = `${ip}:${c.req.path}`;

  try {
    if (env.RATE_LIMITER) {
      const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
      const response = await stub.fetch('https://internal/rate-limit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, windowMs, maxRequests })
      });

      if (response.ok) {
        const decision = (await response.json()) as { allowed: boolean, retryAfterSeconds: number };

        if (!decision.allowed) {
          c.header('retry-after', String(decision.retryAfterSeconds));
          return c.json({ error: 'rate_limit_exceeded', requestId: c.get('requestId') }, 429);
        }

        return next();
      }

      logError('Rate limiter DO failure', c.get('requestId'), { status: response.status, path: c.req.path });
    }
  } catch (error) {
    logError('Rate limiter DO error', c.get('requestId'), { error, path: c.req.path });
  }

  const fallback = fallbackRateLimitCheck(key, now, windowMs, maxRequests);
  if (!fallback.allowed) {
    const retryAfterSeconds = fallback.retryAfterSeconds;
    c.header('retry-after', String(Math.max(retryAfterSeconds, 1)));
    return c.json({ error: 'rate_limit_exceeded', requestId: c.get('requestId') }, 429);
  }

  return next();
});

// Compose the application layer with cache and API dependencies.
const createAppLayer = (env: Bindings | undefined) => {
  const runtimeEnv = env ?? {};
  const cacheTtl = parseBoundedInt(runtimeEnv.CACHE_TTL, 600, 10, 86400);
  const apiTimeout = parseBoundedInt(runtimeEnv.API_TIMEOUT, 5000, 500, 30000);

  // Single merged layer with proper dependencies
  return Layer.merge(CacheServiceLive(cacheTtl), Layer.provide(DeFiLlamaClientLive(apiTimeout), FetchHttpClient.layer));
};

// Run a handler effect with the configured dependency layer.
const runHandler = async <A, E>(
  c: {
    env: Bindings,
    json: (data: unknown, status?: number) => Response,
    get: (key: 'requestId') => string,
    req: { path: string }
  },
  program: Effect.Effect<A, E, DeFiLlamaClient | CacheService>
): Promise<Response> => {
  try {
    const layer = createAppLayer(c.env);
    const result = await Effect.runPromiseExit(Effect.provide(program, layer));

    return Exit.match(result, {
      onFailure: (cause) => {
        const error = Cause.squash(cause);

        if (typeof error === 'object' && error !== null && '_tag' in error) {
          const taggedError = error as { _tag: string, [key: string]: any };

          switch (taggedError._tag) {
            case 'InvalidProtocolError':
              return c.json(
                { error: `Protocol '${taggedError.protocol}' not found`, requestId: c.get('requestId') },
                404
              );

            case 'ChainNotFoundError':
              return c.json({
                error: `Chain '${taggedError.chain}' not found for protocol '${taggedError.protocol}'`,
                availableChains: taggedError.availableChains,
                requestId: c.get('requestId')
              }, 404);

            case 'ApiError':
              logError('API Error', c.get('requestId'), {
                message: taggedError.message,
                statusCode: taggedError.statusCode,
                path: c.req.path
              });
              return c.json(
                { error: taggedError.message, requestId: c.get('requestId') },
                taggedError.statusCode || 500
              );

            case 'UpstreamError':
              logError('Upstream Error', c.get('requestId'), { message: taggedError.message, path: c.req.path });
              return c.json({ error: 'Service temporarily unavailable', requestId: c.get('requestId') }, 502);

            case 'ParseError':
              console.warn('Parse Error', {
                requestId: c.get('requestId'),
                message: taggedError.message,
                path: c.req.path
              });
              return c.json(
                { error: taggedError.message, requestId: c.get('requestId') },
                taggedError.source === 'query' ? 400 : 500
              );

            default:
              logError('Unhandled Error', c.get('requestId'), { error, path: c.req.path });
              return c.json({ error: 'Internal server error', requestId: c.get('requestId') }, 500);
          }
        }

        logError('Unknown Error', c.get('requestId'), { error, path: c.req.path });
        return c.json({ error: 'Internal server error', requestId: c.get('requestId') }, 500);
      },
      onSuccess: (value) => c.json(value)
    });
  } catch (error) {
    logError('Runtime Error', c.get('requestId'), { error, path: c.req.path });
    return c.json({ error: 'Internal server error', requestId: c.get('requestId') }, 500);
  }
};

// TVL endpoint
app.get('/protocol/:protocol/tvl/:chain?', async (c) => {
  const protocol = c.req.param('protocol');
  const chain = c.req.param('chain') || 'Ethereum';

  const program = Effect.gen(function*() {
    const rawQuery = { days: c.req.query('days'), limit: c.req.query('limit') };

    const queryParams = yield* Schema.decodeUnknown(QueryParams)(rawQuery).pipe(
      Effect.mapError((cause) =>
        new ParseError({ message: `Invalid query parameters: ${String(cause)}`, source: 'query', cause })
      )
    );

    return yield* handleTvl(protocol, chain, queryParams);
  });

  return runHandler(c, program);
});

// Chains endpoint
app.get('/protocol/:protocol/chains', async (c) => {
  const protocol = c.req.param('protocol');
  return runHandler(c, handleChains(protocol));
});

// Lightweight health check that verifies runtime availability.
app.get('/health', (c) => {
  // Don't even create layers or effects - just check basic runtime health
  const hasCache = typeof caches !== 'undefined' || typeof Map !== 'undefined';
  const hasNetwork = typeof fetch !== 'undefined';

  if (hasCache && hasNetwork) {
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      runtime: { cache: hasCache ? 'available' : 'unavailable', network: hasNetwork ? 'available' : 'unavailable' }
    }, 200);
  }

  return c.json({
    status: 'degraded',
    timestamp: new Date().toISOString(),
    runtime: { cache: hasCache ? 'available' : 'unavailable', network: hasNetwork ? 'available' : 'unavailable' }
  }, 503);
});

// Root endpoint
app.get('/', (c) => {
  const env = c.env ?? {};
  const cacheTtl = parseBoundedInt(env.CACHE_TTL, 600, 10, 86400);
  const apiTimeout = parseBoundedInt(env.API_TIMEOUT, 5000, 500, 30000);

  return c.json({
    service: 'DeFiLlama TVL Proxy (Effect-powered)',
    status: 'operational',
    version: '0.1.0',
    config: { cacheTtl: `${cacheTtl}s`, apiTimeout: `${apiTimeout}ms` },
    endpoints: ['/protocol/{protocol}/tvl/{chain}?days=30&limit=100', '/protocol/{protocol}/chains', '/health'],
    examples: ['/protocol/aave/tvl/Ethereum', '/protocol/uniswap/tvl/Arbitrum?days=7&limit=100']
  });
});

app.notFound((c) => {
  return c.json({ error: 'not_found', requestId: c.get('requestId') }, 404);
});

app.onError((error, c) => {
  logError('Unhandled application error', c.get('requestId'), { error, path: c.req.path });
  return c.json({ error: 'Internal server error', requestId: c.get('requestId') }, 500);
});

export default app;
export { RateLimiterDurableObject };
```
