import { useEffect, useState } from 'react';
import { minutesOfDay, msUntilNextMinute } from '@/lib/time';

/**
 * Minutes since Malé midnight, re-read every time the wall clock changes minute.
 *
 * Anything that answers "when is the next bus" has to be driven by this rather
 * than by a `minutesOfDay()` read taken once at mount: a rider who opens the app
 * at 13:55 and watches it until 14:00 is the ordinary case, and without a tick
 * the 14:00 departure sits at the top of the list long after it has pulled away.
 *
 * Floored to the whole minute so the value is stable within a minute — a
 * fractional clock would invalidate every downstream memo on every tick for no
 * visible gain, since RTL timetables have minute granularity.
 */
export function useNowMinutes(): number {
  const [minute, setMinute] = useState(() => Math.floor(minutesOfDay()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      setMinute(Math.floor(minutesOfDay()));
      // 100ms past the boundary, so a tick that fires a hair early does not read
      // the minute it was meant to leave behind.
      timer = setTimeout(tick, msUntilNextMinute() + 100);
    };

    tick();

    // A locked phone or a backgrounded tab has its timers throttled to minutes
    // or stopped outright, so returning to the app re-reads the clock instead of
    // trusting the timer to have kept count while the screen was off.
    const resync = () => {
      if (timer !== undefined) clearTimeout(timer);
      tick();
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('focus', resync);
    window.addEventListener('pageshow', resync);

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('focus', resync);
      window.removeEventListener('pageshow', resync);
    };
  }, []);

  return minute;
}
