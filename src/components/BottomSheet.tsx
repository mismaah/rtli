import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { SIDE_PANEL_WIDTH, useWideLayout } from '@/hooks/useWideLayout';

export type SheetSnap = 'collapsed' | 'half' | 'full';

const SNAP_VH: Record<SheetSnap, number> = {
  collapsed: 0.18,
  half: 0.55,
  full: 0.92,
};

interface BottomSheetProps {
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  children: ReactNode;
  /** Rendered inside the grab area, beside the handle. */
  header?: ReactNode;
  /**
   * Pinned below the scrolling content — for the one action a screen exists to
   * offer. Kept out of the scroll area so it cannot cover what it sits under,
   * and so a rider mid-journey never has to scroll to find the button.
   */
  footer?: ReactNode;
}

/**
 * Draggable bottom sheet on phones; a fixed side panel once the screen is wide
 * enough to show the map beside it.
 *
 * The drag is built on pointer events rather than a library so it works
 * identically with touch, pen and mouse, and so the sheet can be dismissed
 * one-handed.
 */
export function BottomSheet({ snap, onSnapChange, header, footer, children }: BottomSheetProps) {
  const [dragOffset, setDragOffset] = useState(0);
  const startY = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const wide = useWideLayout();

  const heightPct = SNAP_VH[snap] * 100;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    startY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (startY.current == null) return;
    setDragOffset(e.clientY - startY.current);
  };

  const onPointerUp = () => {
    if (startY.current == null) return;
    const offset = dragOffset;
    startY.current = null;
    setDragOffset(0);

    const order: SheetSnap[] = ['collapsed', 'half', 'full'];
    const index = order.indexOf(snap);
    // Positive offset means dragged downward, so toward a smaller snap.
    if (offset > 60 && index > 0) onSnapChange(order[index - 1]);
    else if (offset < -60 && index < order.length - 1) onSnapChange(order[index + 1]);
  };

  useEffect(() => {
    if (snap !== 'full') sheetRef.current?.scrollTo({ top: 0 });
  }, [snap]);

  // Wide screens split rather than stack: the panel sits beside the map, so
  // there is nothing to drag out of the way and no snap points to honour.
  if (wide) {
    return (
      <aside
        className="pointer-events-auto z-20 flex h-full shrink-0 flex-col border-l border-white/10 bg-ink-900"
        style={{ width: SIDE_PANEL_WIDTH, paddingTop: 'var(--safe-top)' }}
      >
        {header ? <div className="shrink-0 px-4 pt-4">{header}</div> : null}
        <div
          ref={sheetRef}
          className="no-scrollbar flex-1 overflow-y-auto overscroll-contain px-4 pt-4"
          style={{ paddingBottom: 'calc(var(--safe-bottom) + 1rem)' }}
        >
          {children}
        </div>
        {footer ? (
          <div
            className="shrink-0 border-t border-white/10 px-4 pt-3"
            style={{ paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)' }}
          >
            {footer}
          </div>
        ) : null}
      </aside>
    );
  }

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-2xl border-t border-white/10 bg-ink-900/95 shadow-[0_-8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl"
      style={{
        height: `${heightPct}dvh`,
        transform: `translateY(${Math.max(0, dragOffset)}px)`,
        transition: startY.current == null ? 'height 220ms ease, transform 220ms ease' : 'none',
      }}
    >
      <div
        className="shrink-0 cursor-grab touch-none px-4 pt-2 pb-1 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-white/25" />
        {header ? <div className="pt-2">{header}</div> : null}
      </div>

      <div
        ref={sheetRef}
        className="no-scrollbar flex-1 overflow-y-auto overscroll-contain px-4"
        style={{ paddingBottom: footer ? '0.75rem' : 'calc(var(--safe-bottom) + 1rem)' }}
      >
        {children}
      </div>
      {footer ? (
        <div
          className="shrink-0 border-t border-white/10 px-4 pt-3"
          style={{ paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)' }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
