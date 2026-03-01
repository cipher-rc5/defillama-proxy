// file: src/handler.ts
// description: Request handlers for TVL and chains endpoints
// reference: internal

import { Effect, Option, Schema } from 'effect';
import { DeFiLlamaClient } from './api';
import { CacheService } from './cache';
import { ApiError, ChainNotFoundError, InvalidProtocolError, UpstreamError } from './errors';
import { ChainsResponse, ProtocolData, QueryParams, TvlResponse } from './schema';

const resolveChainKey = (
  chainTvls: Record<string, { readonly tvl: ReadonlyArray<{ readonly date: number, readonly totalLiquidityUSD: number }> }>,
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
