// file: src/api.ts
// description: DeFiLlama API client service with retry logic and error handling
// reference: internal

import { HttpClient, HttpClientRequest } from '@effect/platform';
import { Context, Duration, Effect, Layer, pipe, Schedule, Schema } from 'effect';
import { ApiError, InvalidProtocolError, UpstreamError } from './errors';
import { ProtocolData } from './schema';

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
