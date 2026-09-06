import { useEffect, useState } from 'react';

/**
 * How long a reachability probe is given before it counts as a failure. The
 * question is only whether anything answers at all, so this is generous.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether the network can actually be reached, asked by reaching it.
 *
 * Deliberately not `navigator.onLine`, which is wrong in both directions: it
 * reports true for any interface that exists, including one with no route to
 * the internet, and it reports false on connections that work perfectly — a
 * VPN, a virtual adapter, or a browser that simply got it wrong. Taken
 * literally, that second case pins an "Offline — no live bus times" banner over
 * a session whose every request is coming back 200.
 */
export async function reachable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // This app's own origin: no backend needed, and a few KB. The cache-busting
    // parameter is load-bearing — without it the service worker answers from
    // its precache and a device with no network at all looks reachable.
    const res = await fetch(`/favicon-32.png?online-probe=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tracks connectivity so the UI can say when it is working from cached data.
 *
 * `navigator.onLine` is read as a suspicion rather than a verdict. A claim of
 * *offline* has to be confirmed by a request that actually fails before anyone
 * is told about it; a claim of *online* is taken at face value, because the
 * honest signal for the opposite case is the graph falling back to its saved
 * snapshot — which the caller already has, and which is what the banner is
 * really about.
 */
export function useOnline(): boolean {
  // Optimistic, because the two mistakes are not the same size: a wrong
  // "offline" is a banner the rider can see and disbelieve, while a wrong
  // "online" shows nothing and is already covered by that snapshot fallback.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const verify = () => {
      void reachable().then((ok) => {
        if (!cancelled) setOnline(ok);
      });
    };

    const up = () => setOnline(true);
    // A `navigator.onLine` stuck at false never fires the `online` event that
    // would otherwise clear this, so coming back to the tab re-asks.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !navigator.onLine) verify();
    };

    if (!navigator.onLine) verify();

    window.addEventListener('online', up);
    window.addEventListener('offline', verify);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('online', up);
      window.removeEventListener('offline', verify);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return online;
}
