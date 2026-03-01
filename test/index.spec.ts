// file: test/index.spec.ts
// description: Worker request handling tests
// reference: internal

import { describe, expect, it } from 'bun:test';
import app from '../src/index';

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
});
