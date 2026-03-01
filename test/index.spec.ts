// file: test/index.spec.ts
// description: Worker request handling tests
// reference: internal

import { describe, expect, it } from 'bun:test';
import app from '../src/index';

const createFakeRateLimiterNamespace = (maxRequests: number) => {
  const store = new Map<string, number>();

  return {
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        fetch: async () => {
          const next = (store.get(id.name) ?? 0) + 1;
          store.set(id.name, next);

          const allowed = next <= maxRequests;
          return new Response(JSON.stringify({
            allowed,
            retryAfterSeconds: allowed ? 0 : 60
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      };
    }
  } as unknown as DurableObjectNamespace;
};

describe('Worker', () => {
  it('returns health status', async () => {
    const response = await app.fetch(new Request('http://example.com/health'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('healthy');
  });

  it('adds production security and tracing headers', async () => {
    const response = await app.fetch(new Request('http://example.com/health'));

    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-response-time-ms')).toBeTruthy();
  });

  it('enforces rate limiting', async () => {
    const env = {
      RATE_LIMIT_MAX: '1',
      RATE_LIMIT_WINDOW_MS: '60000'
    };

    const first = await app.fetch(new Request('http://example.com/health', {
      headers: { 'cf-connecting-ip': '198.51.100.10' }
    }), env);
    expect(first.status).toBe(200);

    const second = await app.fetch(new Request('http://example.com/health', {
      headers: { 'cf-connecting-ip': '198.51.100.10' }
    }), env);
    expect(second.status).toBe(429);

    const body = (await second.json()) as { error: string, requestId: string };
    expect(body.error).toBe('rate_limit_exceeded');
    expect(body.requestId).toBeTruthy();
    expect(second.headers.get('retry-after')).toBeTruthy();
  });

  it('rejects invalid query bounds before upstream fetch', async () => {
    const response = await app.fetch(new Request('http://example.com/protocol/aave/tvl/Ethereum?days=9000'));

    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string, requestId: string };
    expect(body.error).toContain('Invalid query parameters');
    expect(body.requestId).toBeTruthy();
  });

  it('returns not_found with request id for unknown routes', async () => {
    const response = await app.fetch(new Request('http://example.com/does-not-exist'));

    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string, requestId: string };
    expect(body.error).toBe('not_found');
    expect(body.requestId).toBeTruthy();
  });

  it('applies CORS allowlist when configured', async () => {
    const env = { CORS_ORIGINS: 'https://allowed.example.com' };
    const response = await app.fetch(new Request('http://example.com/health', {
      headers: { origin: 'https://allowed.example.com' }
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com');
  });

  it('uses durable object rate limiter when configured', async () => {
    const env = {
      RATE_LIMIT_MAX: '1',
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMITER: createFakeRateLimiterNamespace(1)
    };

    const first = await app.fetch(new Request('http://example.com/health', {
      headers: { 'cf-connecting-ip': '198.51.100.88' }
    }), env);
    expect(first.status).toBe(200);

    const second = await app.fetch(new Request('http://example.com/health', {
      headers: { 'cf-connecting-ip': '198.51.100.88' }
    }), env);
    expect(second.status).toBe(429);
  });
});
