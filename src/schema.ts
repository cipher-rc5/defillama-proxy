// file: src/schema.ts
// description: Data schemas for API requests and responses
// reference: internal

import { Schema } from 'effect';

// TVL data entry schema
export const TvlEntry = Schema.Struct({ date: Schema.Number, totalLiquidityUSD: Schema.Number });
export type TvlEntry = Schema.Schema.Type<typeof TvlEntry>;

// Chain TVL data schema
export class ChainTvl extends Schema.Class<ChainTvl>('ChainTvl')({ tvl: Schema.Array(TvlEntry) }) {}

// Protocol data schema from DeFiLlama API
export class ProtocolData
  extends Schema.Class<ProtocolData>('ProtocolData')({ chainTvls: Schema.Record({ key: Schema.String, value: ChainTvl }) }) {}

// Query parameters for TVL endpoint
export class QueryParams
  extends Schema.Class<QueryParams>('QueryParams')({
    days: Schema.optionalWith(Schema.NumberFromString.pipe(Schema.nonNegative()), { default: () => 30 }),
    limit: Schema.optionalWith(Schema.NumberFromString.pipe(Schema.nonNegative()), { default: () => 0 })
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
  extends Schema.Class<ChainsResponse>('ChainsResponse')({ protocol: Schema.String, chains: Schema.Array(Schema.String) }) {}
