import type { Route } from '@/lib/transit/types';

/** Route badge painted in RTL's own colour for that route. */
export function RouteChip({ route, size = 'md' }: { route: Route; size?: 'sm' | 'md' }) {
  return (
    <span
      className={
        size === 'sm'
          ? 'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-bold leading-none'
          : 'inline-flex items-center rounded-lg px-2 py-1 text-xs font-bold leading-none'
      }
      style={{ background: route.color, color: readableOn(route.color) }}
    >
      {route.routeNumber}
    </span>
  );
}

/** Pick black or white text so the badge stays legible on any route colour. */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Rec. 709 relative luminance.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? '#0b1120' : '#ffffff';
}
