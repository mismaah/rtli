import { useCallback, useSyncExternalStore } from 'react';

/**
 * Width at which the phone layout (map with a sheet dragged over it) gives way
 * to a split view: map on the left, panel on the right. Chosen so a tablet in
 * landscape splits but the same tablet held upright keeps the sheet.
 */
export const WIDE_LAYOUT_QUERY = '(min-width: 900px)';

/** Width of the side panel in the split layout, in CSS pixels. */
export const SIDE_PANEL_WIDTH = 416;

/** Reactive `matchMedia`. Reports false where there is no window. */
export function useWideLayout(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia(WIDE_LAYOUT_QUERY);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE_LAYOUT_QUERY).matches,
    () => false,
  );
}
