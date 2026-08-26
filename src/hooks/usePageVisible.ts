import { useEffect, useState } from 'react';

/**
 * Whether the tab is in the foreground. Live polling is gated on this so a
 * backgrounded app stops hammering the RTL API and the user's data plan.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}
