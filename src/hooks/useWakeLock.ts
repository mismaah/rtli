import { useEffect } from 'react';

/**
 * Keeps the screen awake while a journey is running.
 *
 * A rider walking to a stop with the app open is not touching the phone, and a
 * screen that blacks out halfway there means unlocking it one-handed at a
 * junction to find out where to go next. The lock is dropped the moment the
 * journey ends, and re-taken on return to the tab because the browser releases
 * it whenever the page is hidden.
 *
 * Screen Wake Lock is not everywhere and needs a secure context, so every call
 * is best-effort: without it the journey simply behaves as any other screen.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      if (released || document.visibilityState !== 'visible') return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        // Denied by the browser, or the tab lost focus mid-request. Nothing to do.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
