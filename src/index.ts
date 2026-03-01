// file: src/index.ts
// description: Main application entry point with Hono server and Effect integration
// reference: internal

import { FetchHttpClient } from '@effect/platform';
import { Cause, Effect, Exit, Layer, Schema } from 'effect';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { DeFiLlamaClient, DeFiLlamaClientLive } from './api';
import { CacheService, CacheServiceLive } from './cache';
import { ParseError } from './errors';
import { handleChains, handleTvl } from './handler';
import { QueryParams } from './schema';

interface Bindings {
  CACHE_TTL?: string;
  API_TIMEOUT?: string;
  RATE_LIMIT_WINDOW_MS?: string;
  RATE_LIMIT_MAX?: string;
  CORS_ORIGINS?: string;
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
  return originsValue
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
};

const rateLimitStore = new Map<string, { count: number, resetAt: number }>();
const RATE_LIMIT_STORE_MAX_ENTRIES = 10000;

const pruneRateLimitStore = (now: number): void => {
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }

  if (rateLimitStore.size <= RATE_LIMIT_STORE_MAX_ENTRIES) {
    return;
  }

  for (const key of rateLimitStore.keys()) {
    rateLimitStore.delete(key);
    if (rateLimitStore.size <= RATE_LIMIT_STORE_MAX_ENTRIES) {
      break;
    }
  }
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
  pruneRateLimitStore(now);
  const forwardedFor = c.req.header('x-forwarded-for');
  const ip = c.req.header('cf-connecting-ip') ?? forwardedFor?.split(',')[0]?.trim() ?? 'unknown';
  const key = `${ip}:${c.req.path}`;

  const current = rateLimitStore.get(key);
  if (!current || now >= current.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }

  if (current.count >= maxRequests) {
    const retryAfterSeconds = Math.ceil((current.resetAt - now) / 1000);
    c.header('retry-after', String(Math.max(retryAfterSeconds, 1)));
    return c.json({
      error: 'rate_limit_exceeded',
      requestId: c.get('requestId')
    }, 429);
  }

  current.count += 1;
  rateLimitStore.set(key, current);
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
              return c.json({
                error: `Protocol '${taggedError.protocol}' not found`,
                requestId: c.get('requestId')
              }, 404);

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
              return c.json({ error: taggedError.message, requestId: c.get('requestId') }, taggedError.statusCode || 500);

            case 'UpstreamError':
              logError('Upstream Error', c.get('requestId'), {
                message: taggedError.message,
                path: c.req.path
              });
              return c.json({ error: 'Service temporarily unavailable', requestId: c.get('requestId') }, 502);

            case 'ParseError':
              console.warn('Parse Error', {
                requestId: c.get('requestId'),
                message: taggedError.message,
                path: c.req.path
              });
              return c.json({
                error: taggedError.message,
                requestId: c.get('requestId')
              }, taggedError.source === 'query' ? 400 : 500);

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
