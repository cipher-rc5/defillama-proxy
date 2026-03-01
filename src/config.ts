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
