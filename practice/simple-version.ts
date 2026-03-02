// simple-version.ts

import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// Enable CORS for Dune Analytics
app.use('*', cors());

// Types for the API response
interface TvlEntry {
  date: number;
  totalLiquidityUSD: number;
}

interface ChainTvls {
  [chain: string]: { tvl: TvlEntry[] };
}

interface ProtocolResponse {
  chainTvls: ChainTvls;
}

// Helper to filter data by days
function filterByDays(data: TvlEntry[], days: number): TvlEntry[] {
  const cutoffDate = Date.now() / 1000 - (days * 24 * 60 * 60);
  return data.filter(entry => entry.date >= cutoffDate);
}

// Main endpoint for protocol TVL data
app.get('/protocol/:protocol/tvl/:chain?', async (c) => {
  try {
    const protocol = c.req.param('protocol');
    const chain = c.req.param('chain') || 'Ethereum';
    const days = parseInt(c.req.query('days') || '30');
    const limit = parseInt(c.req.query('limit') || '0');

    // Fetch data from DeFiLlama
    const response = await fetch(`https://api.llama.fi/protocol/${protocol}`);

    // Check if protocol exists
    if (!response.ok || response.status === 404) {
      return c.json({ error: 'invalid_protocol_requested' }, 404);
    }

    const data: ProtocolResponse = await response.json();

    // Validate the response has expected structure
    if (!data.chainTvls) {
      return c.json({ error: 'invalid_protocol_requested' }, 404);
    }

    // Check if chain exists for this protocol
    if (!data.chainTvls[chain]) {
      return c.json({ error: `Chain ${chain} not found for protocol ${protocol}`, availableChains: Object.keys(data.chainTvls) }, 404);
    }

    // Get TVL data for specified chain
    let tvlData = data.chainTvls[chain].tvl;

    // Filter by days if specified
    if (days > 0) {
      tvlData = filterByDays(tvlData, days);
    }

    // Apply limit if specified
    if (limit > 0) {
      tvlData = tvlData.slice(-limit); // Get last N entries
    }

    // Return filtered data
    return c.json({ protocol, chain, days: days > 0 ? days : 'all', count: tvlData.length, tvl: tvlData });
  } catch (error) {
    // If JSON parsing fails or other errors, likely invalid protocol
    return c.json({ error: 'invalid_protocol_requested' }, 404);
  }
});

// Endpoint to get available chains for a protocol
app.get('/protocol/:protocol/chains', async (c) => {
  try {
    const protocol = c.req.param('protocol');
    const response = await fetch(`https://api.llama.fi/protocol/${protocol}`);

    if (!response.ok || response.status === 404) return c.json({ error: 'invalid_protocol_requested' }, 404);

    const data: ProtocolResponse = await response.json();

    // Validate response structure
    if (!data.chainTvls) return c.json({ error: 'invalid_protocol_requested' }, 404);

    const chains = Object.keys(data.chainTvls);

    return c.json({ protocol, chains });
  } catch (error) {
    return c.json({ error: 'invalid_protocol_requested' }, 404);
  }
});

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    service: 'DeFiLlama Protocol TVL Proxy',
    endpoint: ['/protocol/{protocol}/tvl/{chain}?days=30&limit=10', '/protocol/{protocol}/chains'],
    examples: ['/protocol/aave/tvl/Ethereum', '/protocol/uniswap/tvl/Arbitrum?days=7'],
    defaultChain: 'Ethereum',
    queryParams: {
      days: 'Number of days to look back (default: 30, 0 for all data)',
      limit: 'Maximum number of entries to return (default: 0 for no limit)'
    }
  });
});

export default app;
