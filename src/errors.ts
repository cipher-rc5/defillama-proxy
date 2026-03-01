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
