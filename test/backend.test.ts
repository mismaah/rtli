import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, COOLDOWN_MS } from '@/api/backend';
import { RECHECK_MS, nextRecheckDelay, type TransitGraphResult } from '@/hooks/useTransitGraph';

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

/**
 * The 15-second budget on a direct RTL call.
 *
 * It was dead for as long as every caller passed a signal — which all of them
 * do, because React Query supplies one — since handing that signal to `fetch`
 * left the timeout aborting a controller nothing was listening to. A network
 * that blackholes port 4455 rather than refusing on it is the case that
 * matters: the connection hangs, and without this the app waits on it forever.
 */
describe('the direct RTL call giving up', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Re-imports with no backend configured, so the direct call is the only path. */
  async function directOnly() {
    vi.stubEnv('VITE_API_BASE', '');
    vi.resetModules();
    return import('@/api/rtl');
  }

  /** Never answers, and rejects on abort exactly as the real `fetch` does. */
  function hangingFetch() {
    return vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = () => reject(new DOMException('Aborted', 'AbortError'));
          // A signal that is already aborted rejects straight away rather than
          // waiting for an event that has been and gone.
          if (init?.signal?.aborted) fail();
          else init?.signal?.addEventListener('abort', fail, { once: true });
        }),
    ) as typeof fetch;
  }

  it('abandons a connection that hangs, even when the caller passed a signal', async () => {
    const { fetchRouteDetails, RtlApiError } = await directOnly();
    vi.useFakeTimers();
    globalThis.fetch = hangingFetch();

    // A signal that is never aborted: exactly what React Query hands a query
    // that nobody navigates away from.
    const pending = fetchRouteDetails(new AbortController().signal);
    const settled = expect(pending).rejects.toBeInstanceOf(RtlApiError);
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
  });

  it('holds on until the budget is actually spent', async () => {
    const { fetchRouteDetails } = await directOnly();
    vi.useFakeTimers();
    globalThis.fetch = hangingFetch();

    let settled = false;
    const pending = fetchRouteDetails(new AbortController().signal).catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(settled).toBe(true);
  });

  it('reports a caller-driven abort as a cancellation, not as RTL being down', async () => {
    const { fetchRouteDetails, RtlApiError } = await directOnly();
    globalThis.fetch = hangingFetch();

    const controller = new AbortController();
    const pending = fetchRouteDetails(controller.signal);
    controller.abort();

    // Dressed up as an RtlApiError this is indistinguishable from a network
    // failure, and `useTransitGraph` would answer an ordinary unmount with the
    // offline snapshot.
    await expect(pending).rejects.not.toBeInstanceOf(RtlApiError);
  });
});

/**
 * Recovering from a fallback.
 *
 * The graph is fetched once and held for half an hour, so whether this returns
 * a delay or `false` decides whether a session that started badly ever gets
 * better on its own. The snapshot case is the one that used to be missed: it
 * reports `via: null`, so a rule written only for `via === 'rtl'` left the
 * worst state as the only one with no way back.
 */
describe('nextRecheckDelay', () => {
  const served = (over: Partial<TransitGraphResult>): TransitGraphResult =>
    ({ graph: {}, source: 'network', fromCache: false, via: 'backend', ...over }) as TransitGraphResult;

  it('leaves a graph the backend served alone', () => {
    expect(nextRecheckDelay(served({}), 1, true)).toBe(false);
  });

  it('re-asks once for a graph RTL served', () => {
    expect(nextRecheckDelay(served({ via: 'rtl' }), 1, true)).toBe(RECHECK_MS);
  });

  it('stops after that one re-ask', () => {
    expect(nextRecheckDelay(served({ via: 'rtl' }), 2, true)).toBe(false);
  });

  it('does not spend the re-ask while the breaker holds the backend aside', () => {
    expect(nextRecheckDelay(served({ via: 'rtl' }), 1, false)).toBe(false);
  });

  it('keeps asking while the app is running on the saved snapshot', () => {
    const cached = served({ source: 'cache', fromCache: true, via: null });
    expect(nextRecheckDelay(cached, 1, true)).toBe(RECHECK_MS);
    // Unbounded, unlike the RTL case: a backend that was merely restarting must
    // not leave the offline banner up for the rest of the session.
    expect(nextRecheckDelay(cached, 2, true)).toBe(RECHECK_MS);
    expect(nextRecheckDelay(cached, 12, true)).toBe(RECHECK_MS);
  });

  it('keeps asking from the snapshot even while the backend is set aside', () => {
    // The re-ask falls through to RTL on its own, and reaching RTL is the whole
    // point when there are no live bus times at all.
    const cached = served({ source: 'cache', fromCache: true, via: null });
    expect(nextRecheckDelay(cached, 3, false)).toBe(RECHECK_MS);
  });

  it('asks nothing before the first answer has arrived', () => {
    expect(nextRecheckDelay(undefined, 0, true)).toBe(false);
  });
});
