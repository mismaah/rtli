import { describe, expect, it } from 'vitest';
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
