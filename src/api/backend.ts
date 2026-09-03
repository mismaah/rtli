/**
 * The optional rtl-improved backend, and the rule for when to stop asking it.
 *
 * Every call here is best-effort: a failure returns null and the caller goes
 * straight to RTL, so the app behaves exactly as it did before the server
 * existed. The one thing that must not happen is a *slow* failure on every
 * request — without a breaker, a server that is down would make each fetch pay
 * its timeout before falling back, which is a latency regression at precisely
 * the moment things are already going wrong.
 */
import { API_BASE } from '@/config';

/** Consecutive failures before the backend is set aside. */
const FAILURE_THRESHOLD = 2;
/** How long to skip it for once tripped. */
export const COOLDOWN_MS = 60_000;
/**
 * Shorter than RTL's own 15 s: the backend is meant to be the fast path, so one
 * that is slow has already failed at its job and the direct call is the better
 * use of the remaining time.
 *
 * It is a budget for *waiting*, not for transferring, which is why the graph
 * overrides it below. Giving a 300 KB payload less time than the fallback that
 * would replace it means abandoning a working server for a slower path.
 */
const BACKEND_TIMEOUT_MS = 6_000;

/**
 * The budget for the one large payload, sized against RTL's own 15 s rather
 * than against how fast a healthy backend answers.
 *
 * Failing over here is not the cheap move it is elsewhere: the graph is fetched
 * once at startup, held for half an hour, and the fallback fetches the same
 * routes and timetables uncompressed and directly. A client that gives up on
 * this at six seconds has not saved itself anything — it has taken the slower
 * road, on the assumption that the fast one is broken.
 */
export const GRAPH_TIMEOUT_MS = 12_000;

/**
 * Trips after repeated failures and heals after a cooldown.
 *
 * Time is injected rather than read from the clock so the behaviour is testable,
 * matching how the bus-tracking inference is written.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = FAILURE_THRESHOLD,
    private readonly cooldownMs = COOLDOWN_MS,
  ) {}

  /**
   * True when the backend should be skipped outright.
   *
   * Asking spends the one probe the cooldown hands out, so this is for callers
   * that are about to make the request either way. See `peekOpen`.
   */
  isOpen(now: number): boolean {
    if (this.failures < this.threshold) return false;
    if (now - this.openedAt >= this.cooldownMs) {
      // Cooldown elapsed: allow one probe through rather than healing blindly.
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
  }

  /**
   * The same answer, without spending that probe.
   *
   * A caller deciding whether an optional request is worth making needs to read
   * the state rather than change it — otherwise merely wondering consumes the
   * attempt the next real request was going to get.
   */
  peekOpen(now: number): boolean {
    return this.failures >= this.threshold && now - this.openedAt < this.cooldownMs;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(now: number): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = now;
  }
}

const breaker = new CircuitBreaker();

export interface BackendOptions {
  /** Overrides the default wait budget; see GRAPH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test seam: the clock the breaker is read against. */
  now?: number;
}

/**
 * Fetches JSON from the backend, or returns null if it is unconfigured,
 * skipped, or fails for any reason.
 *
 * Null always means "ask RTL instead" and never propagates as an error, so a
 * backend problem can never be something the rider sees.
 */
export async function fetchFromBackend<T>(
  path: string,
  signal?: AbortSignal,
  { timeoutMs = BACKEND_TIMEOUT_MS, now = Date.now() }: BackendOptions = {},
): Promise<T | null> {
  if (!API_BASE) return null;
  if (breaker.isOpen(now)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      breaker.recordFailure(Date.now());
      return null;
    }
    const data = (await res.json()) as T;
    breaker.recordSuccess();
    return data;
  } catch {
    // A caller-driven abort is not the backend's fault, so it must not count
    // against it — otherwise ordinary navigation would trip the breaker.
    if (signal?.aborted) return null;
    breaker.recordFailure(Date.now());
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Whether the backend is worth a request right now: configured, and not being
 * skipped after repeated failures.
 *
 * For deciding whether to *re-ask* after a fallback — a question worth
 * answering only when the answer might have changed, and never at the cost of
 * the breaker's own probe.
 */
export function backendWorthAsking(now: number = Date.now()): boolean {
  return API_BASE !== null && !breaker.peekOpen(now);
}

/** Test seam: forget any recorded failures. */
export function resetBackendBreaker(): void {
  breaker.recordSuccess();
}
