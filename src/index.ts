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
  caches?: { default: Cache };
}

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

// Compose the application layer with cache and API dependencies.
const createAppLayer = (env: Bindings) => {
  const cacheTtl = parseInt(env.CACHE_TTL || '600', 10);
  const apiTimeout = parseInt(env.API_TIMEOUT || '5000', 10);

  // Single merged layer with proper dependencies
  return Layer.merge(CacheServiceLive(cacheTtl), Layer.provide(DeFiLlamaClientLive(apiTimeout), FetchHttpClient.layer));
};

// Run a handler effect with the configured dependency layer.
const runHandler = async <A, E>(
  c: { env: Bindings, json: (data: unknown, status?: number) => Response },
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
              return c.json({ error: `Protocol '${taggedError.protocol}' not found` }, 404);

            case 'ChainNotFoundError':
              return c.json({
                error: `Chain '${taggedError.chain}' not found for protocol '${taggedError.protocol}'`,
                availableChains: taggedError.availableChains
              }, 404);

            case 'ApiError':
              console.error('API Error:', taggedError.message);
              return c.json({ error: taggedError.message }, taggedError.statusCode || 500);

            case 'UpstreamError':
              console.error('Upstream Error:', taggedError.message);
              return c.json({ error: 'Service temporarily unavailable' }, 502);

            case 'ParseError':
              console.error('Parse Error:', taggedError.message);
              return c.json({ error: taggedError.message }, taggedError.source === 'query' ? 400 : 500);

            default:
              console.error('Unhandled Error:', error);
              return c.json({ error: 'Internal server error' }, 500);
          }
        }

        console.error('Unknown Error:', error);
        return c.json({ error: 'Internal server error' }, 500);
      },
      onSuccess: (value) => c.json(value)
    });
  } catch (error) {
    console.error('Runtime error:', error);
    return c.json({ error: 'Internal server error' }, 500);
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
  const cacheTtl = parseInt(c.env.CACHE_TTL || '600', 10);
  const apiTimeout = parseInt(c.env.API_TIMEOUT || '5000', 10);

  return c.json({
    service: 'DeFiLlama TVL Proxy (Effect-powered)',
    status: 'operational',
    version: '0.1.0',
    config: { cacheTtl: `${cacheTtl}s`, apiTimeout: `${apiTimeout}ms` },
    endpoints: ['/protocol/{protocol}/tvl/{chain}?days=30&limit=100', '/protocol/{protocol}/chains', '/health'],
    examples: ['/protocol/aave/tvl/Ethereum', '/protocol/uniswap/tvl/Arbitrum?days=7&limit=100']
  });
});

export default app;
