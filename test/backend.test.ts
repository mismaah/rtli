import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, COOLDOWN_MS } from '@/api/backend';

/**
 * The breaker exists so that a backend which is down costs nothing rather than
 * a timeout per request. Everything here is driven by an injected clock, in the
 * same style as the bus-heading inference, so none of it depends on real time.
 */
describe('CircuitBreaker', () => {
  it('stays closed while the backend is healthy', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.isOpen(0)).toBe(false);
    breaker.recordSuccess();
    expect(breaker.isOpen(1000)).toBe(false);
  });

  it('tolerates a single failure without tripping', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(0);
    expect(breaker.isOpen(0)).toBe(false);
  });

  it('opens after consecutive failures reach the threshold', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(0);
    breaker.recordFailure(100);
    expect(breaker.isOpen(100)).toBe(true);
  });

  it('stays open for the whole cooldown', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.isOpen(COOLDOWN_MS - 1)).toBe(true);
  });

  it('lets a probe through once the cooldown elapses', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.isOpen(COOLDOWN_MS)).toBe(false);
  });

  it('re-opens immediately when the probe also fails', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.isOpen(COOLDOWN_MS)).toBe(false); // probe allowed
    breaker.recordFailure(COOLDOWN_MS);
    expect(breaker.isOpen(COOLDOWN_MS)).toBe(true);
  });

  it('closes for good when the probe succeeds', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.isOpen(COOLDOWN_MS);
    breaker.recordSuccess();
    expect(breaker.isOpen(COOLDOWN_MS)).toBe(false);
    // And a later single failure must not instantly reopen it.
    breaker.recordFailure(COOLDOWN_MS + 1);
    expect(breaker.isOpen(COOLDOWN_MS + 1)).toBe(false);
  });

  it('does not trip on failures separated by successes', () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 10; i++) {
      breaker.recordFailure(i * 1000);
      breaker.recordSuccess();
    }
    expect(breaker.isOpen(10_000)).toBe(false);
  });

  // `peekOpen` answers the same question as `isOpen` for callers deciding
  // whether an optional request is worth making. It must not heal anything on
  // the way past, or merely wondering spends the attempt the next real request
  // was going to get.
  it('reports whether the backend is being skipped without spending the probe', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.peekOpen(0)).toBe(true);

    for (let i = 0; i < 5; i++) breaker.peekOpen(COOLDOWN_MS);

    // Unchanged by all that asking: still open, still holding its one probe.
    expect(breaker.peekOpen(COOLDOWN_MS - 1)).toBe(true);
    expect(breaker.isOpen(COOLDOWN_MS - 1)).toBe(true);
    expect(breaker.isOpen(COOLDOWN_MS)).toBe(false);
  });

  it('honours a custom threshold and cooldown', () => {
    const breaker = new CircuitBreaker(3, 5_000);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.isOpen(0)).toBe(false);
    breaker.recordFailure(0);
    expect(breaker.isOpen(0)).toBe(true);
    expect(breaker.isOpen(4_999)).toBe(true);
    expect(breaker.isOpen(5_000)).toBe(false);
  });
});

/**
 * The graph is the request the app opens with, and the one whose answer is held
 * for the rest of the session — so which path served it is a fact the caller
 * needs, and abandoning the backend for RTL is not the cheap move it is
 * elsewhere. Both are exercised here against a stubbed `fetch`, because the
 * choice between the two paths is the whole behaviour.
 */
describe('fetchRouteDetails', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Re-imports the module graph with a backend configured. */
  async function withBackend() {
    vi.stubEnv('VITE_API_BASE', 'https://api.test');
    vi.resetModules();
    return import('@/api/rtl');
  }

  function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const backendGraph = { routeResponse: [{ code: '133' }] } as never;
  const rtlGraph = { routeResponse: [{ code: '122' }] } as never;

  it('reports the backend when the backend answers', async () => {
    const { fetchRouteDetails } = await withBackend();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('api.test');
      return jsonResponse(backendGraph);
    }) as typeof fetch;

    const served = await fetchRouteDetails();
    expect(served.via).toBe('backend');
    expect(served.details).toEqual(backendGraph);
  });

  it('reports the fallback when it has to take it', async () => {
    const { fetchRouteDetails } = await withBackend();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('api.test')
        ? new Response('nope', { status: 502 })
        : jsonResponse(rtlGraph),
    ) as typeof fetch;

    const served = await fetchRouteDetails();
    // Which matters because a caller holding this for half an hour has to know
    // it is holding a fallback, not a preference.
    expect(served.via).toBe('rtl');
    expect(served.details).toEqual(rtlGraph);
  });

  // Six seconds is the right budget for a bus position. It is the wrong one for
  // 300 KB of timetable whose only alternative is fetching the same thing,
  // uncompressed, from further away.
  it('waits longer for the graph than the general backend budget', async () => {
    const { fetchRouteDetails } = await withBackend();
    vi.useFakeTimers();

    let answerBackend: ((res: Response) => void) | undefined;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('api.test')) return Promise.resolve(jsonResponse(rtlGraph));
      return new Promise<Response>((resolve, reject) => {
        answerBackend = resolve;
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    }) as typeof fetch;

    const pending = fetchRouteDetails();
    // Past the six seconds a live request would have been given up at.
    await vi.advanceTimersByTimeAsync(7_000);
    answerBackend?.(jsonResponse(backendGraph));

    const served = await pending;
    expect(served.via).toBe('backend');
  });
});
