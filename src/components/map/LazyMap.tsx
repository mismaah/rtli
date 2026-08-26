import { Suspense, lazy, type ReactNode } from 'react';

/**
 * The map is ~700 KB of JavaScript. Loading it separately lets the search UI
 * and trip results paint straight away instead of waiting on the basemap.
 */
const MapView = lazy(() =>
  import('./MapView').then((m) => ({ default: m.MapView })),
);

export function LazyMap({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <Suspense
      fallback={
        <div className={className}>
          <div className="size-full animate-pulse bg-ink-900" />
        </div>
      }
    >
      <MapView className={className}>{children}</MapView>
    </Suspense>
  );
}
