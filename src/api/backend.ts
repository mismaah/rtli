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
 */
const BACKEND_TIMEOUT_MS = 6_000;

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

  /** True when the backend should be skipped outright. */
  isOpen(now: number): boolean {
    if (this.failures < this.threshold) return false;
    if (now - this.openedAt >= this.cooldownMs) {
      // Cooldown elapsed: allow one probe through rather than healing blindly.
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
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
  now: number = Date.now(),
): Promise<T | null> {
  if (!API_BASE) return null;
  if (breaker.isOpen(now)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
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

/** Test seam: forget any recorded failures. */
export function resetBackendBreaker(): void {
  breaker.recordSuccess();
}
