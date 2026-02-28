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
});
