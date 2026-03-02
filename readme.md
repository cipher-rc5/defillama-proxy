# DeFi Protocol TVL Proxy for Dune Analytics

Cloudflare Worker that proxies and filters DeFiLlama's protocol data to work within Dune Analytics' 4MB response limit. Supports any DeFi protocol available on DeFiLlama.

## Features

- Supports any DeFiLlama protocol (aave, uniswap, curve, etc.)
- Filters TVL data by chain and time period
- Minimal dependencies (only Hono framework)
- CORS enabled for Dune Analytics
- Returns `invalid_protocol_requested` for non-existent protocols
- Configurable days lookback and result limits
- Request IDs and security headers on every response
- Configurable rate limiting and CORS allowlist
- Cloudflare Durable Object distributed rate limiting
- Upstream circuit breaker for repeated API failures

## Setup & Deployment

1. **Install dependencies:**

```bash
bun install
# or npm install
```

2. **Login to Cloudflare:**

```bash
bunx wrangler login
# or npx wrangler login
```

3. **Deploy the worker:**

```bash
bun run deploy
# or npm run deploy
```

Your worker will be deployed to: `https://defi-tvl-proxy.{your-subdomain}.workers.dev`

## API Endpoints

### Get TVL Data

```
GET /protocol/{protocol}/tvl/{chain}?days={days}&limit={limit}
```

Parameters:

- `protocol` (required): Protocol name (e.g., aave, uniswap, curve)
- `chain` (optional): Chain name (default: "Ethereum")
- `days` (optional): Number of days to look back (default: 30, use 0 for all data)
- `limit` (optional): Maximum entries to return (default: 0 for no limit)

### List Available Chains for a Protocol

```
GET /protocol/{protocol}/chains
```

### Health Check

```
GET /health
```

## Configuration

Set environment variables in `.dev.vars` for local development or Worker vars in Cloudflare:

- `CACHE_TTL` (default `600`)
- `API_TIMEOUT` (default `5000`)
- `CORS_ORIGINS` (comma-separated allowlist; default `*` when unset)
- `RATE_LIMIT_MAX` (default `120`)
- `RATE_LIMIT_WINDOW_MS` (default `60000`)

The distributed rate limiter is bound through `wrangler.jsonc` as Durable Object `RATE_LIMITER`.

## Usage in Dune Analytics

### Aave on Ethereum (last 30 days, limit 10):

```sql
WITH tvl_data AS (
    SELECT json_parse(
        http_get('https://your-worker.workers.dev/protocol/aave/tvl/Ethereum?days=30&limit=10')
    ) as response
)
SELECT
    json_extract_scalar(tvl_item, '$.date') as date,
    json_extract_scalar(tvl_item, '$.totalLiquidityUSD') as totalLiquidityUSD
FROM tvl_data
CROSS JOIN UNNEST(
    cast(json_extract(response, '$.tvl') as array(json))
) as t(tvl_item);
```

### Uniswap on Arbitrum (last 7 days):

```sql
WITH tvl_data AS (
    SELECT json_parse(
        http_get('https://your-worker.workers.dev/protocol/uniswap/tvl/Arbitrum?days=7')
    ) as response
)
SELECT
    json_extract_scalar(tvl_item, '$.date') as date,
    json_extract_scalar(tvl_item, '$.totalLiquidityUSD') as totalLiquidityUSD
FROM tvl_data
CROSS JOIN UNNEST(
    cast(json_extract(response, '$.tvl') as array(json))
) as t(tvl_item);
```

### Check available chains for Curve:

```sql
SELECT json_parse(
    http_get('https://your-worker.workers.dev/protocol/curve/chains')
) as available_chains;
```

## Error Handling

The proxy returns `invalid_protocol_requested` when:

- The protocol doesn't exist on DeFiLlama
- The API returns invalid data
- The protocol name is misspelled

Example error response:

```json
{ "error": "Protocol 'invalid-protocol' not found", "requestId": "<request-id>" }
```

## Popular Protocols

Some commonly used protocols:

- `aave` - Lending protocol
- `uniswap` - DEX
- `curve` - Stablecoin DEX
- `compound` - Lending protocol
- `maker` - CDP protocol
- `sushi` - DEX
- `balancer` - DEX
- `yearn` - Yield aggregator
- `convex-finance` - Yield optimizer
- `lido` - Liquid staking

## Development

Run locally:

```bash
bun run dev
# or npm run dev

bunx wrangler dev src/upgrade.ts

bunx wrangler dev
```

The worker will be available at `http://localhost:8787`

Test locally:

```bash
# Test Aave
curl 'http://localhost:8787/protocol/aave/tvl/Ethereum?days=7&limit=5'

# Test invalid protocol
curl http://localhost:8787/protocol/invalid-protocol/tvl/Ethereum

# List chains for Uniswap
curl http://localhost:8787/protocol/uniswap/chains
```

```zsh
curl 'http://localhost:8787/protocol/aave/tvl/Ethereum?days=7'
or
curl http://localhost:8787/protocol/aave/tvl/Ethereum\?days=7
or (zsh-specific)
noglob curl http://localhost:8787/protocol/aave/tvl/Ethereum?days=7
```

Repomix

```bash
repomix --style markdown -o _v01-llm.md --verbose --parsable-style --no-file-summary --include src,package.json,dprint.json,tsconfig.json,wrangler.jsonc

repomix --style markdown -o _v01-llm.md --verbose --parsable-style --no-file-summary  --ignore "/_dev,/node_modules,/.wrangler,./test,.dev.vars,bun.lock"
```

## File Structure

```
defi-tvl-proxy/
├── src/
│   └── index.ts      # Main worker code
├── package.json      # Dependencies
├── wrangler.toml     # Cloudflare config
├── tsconfig.json     # TypeScript config
└── README.md         # This file
```

## Performance Notes

- Each request fetches fresh data from DeFiLlama
- Protocol responses are cached and filtered at query time
- Request spikes are controlled with Durable Object distributed rate limiting
- The 4MB limit typically handles several years of daily TVL data
- Default 30-day window results in ~1-2KB responses per chain

## Troubleshooting

If you get `invalid_protocol_requested`:

1. Check the protocol name spelling
2. Verify the protocol exists on [DeFiLlama](https://defillama.com/)
3. Use the exact protocol slug from DeFiLlama URLs
