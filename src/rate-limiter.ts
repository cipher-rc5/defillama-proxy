interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitRequest {
  key: string;
  windowMs: number;
  maxRequests: number;
}

interface RateLimitResponse {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  limit: number;
}

const makeJson = (payload: RateLimitResponse): Response => {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' }
  });
};

export class RateLimiterDurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let payload: RateLimitRequest;
    try {
      payload = (await request.json()) as RateLimitRequest;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const now = Date.now();
    const key = `rate:${payload.key}`;
    const current = (await this.state.storage.get<RateLimitEntry>(key)) ?? null;

    let entry: RateLimitEntry;
    if (!current || now >= current.resetAt) {
      entry = { count: 1, resetAt: now + payload.windowMs };
    } else {
      entry = { count: current.count + 1, resetAt: current.resetAt };
    }

    await this.state.storage.put(key, entry);

    const allowed = entry.count <= payload.maxRequests;
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    const remaining = allowed ? Math.max(0, payload.maxRequests - entry.count) : 0;

    return makeJson({
      allowed,
      retryAfterSeconds,
      remaining,
      limit: payload.maxRequests
    });
  }
}
