import React from 'react';
import clsx from 'clsx';
import styles from './OverlayScrollArea.module.css';

/** How long the thumb stays after the last scroll event before it fades. */
const SCROLL_IDLE_MS = 800;
const MIN_THUMB_PX = 24;

interface OverlayScrollAreaProps {
  className?: string;
  viewportClassName?: string;
  children: React.ReactNode;
}

interface ThumbGeometry {
  trackHeight: number;
  thumbHeight: number;
  scrollRange: number;
}

function readGeometry(viewport: HTMLElement, track: HTMLElement): ThumbGeometry | null {
  const scrollRange = viewport.scrollHeight - viewport.clientHeight;
  if (scrollRange <= 1) return null;
  const trackHeight = track.clientHeight;
  const thumbHeight = Math.max(MIN_THUMB_PX, Math.round((viewport.clientHeight / viewport.scrollHeight) * trackHeight));
  return { trackHeight, thumbHeight, scrollRange };
}

/**
 * A vertically scrolling region with an overlay thumb.
 *
 * Scrolling itself stays native - wheel, touch, keyboard and `scrollIntoView` all act on a
 * real scroll container - and only the indicator is drawn here. The thumb is positioned by
 * direct style writes inside an animation frame: routing each scroll event through React
 * state would re-render the whole navigation on every frame of a fling.
 */
export function OverlayScrollArea({ className, viewportClassName, children }: OverlayScrollAreaProps) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const thumbRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!root || !viewport || !track || !thumb) return;

    let frame = 0;
    let idleTimer = 0;

    const draw = () => {
      frame = 0;
      // The track has no height while hidden, so it is revealed before it is measured.
      track.hidden = viewport.scrollHeight - viewport.clientHeight <= 1;
      const geometry = readGeometry(viewport, track);
      if (!geometry) return;
      const travel = geometry.trackHeight - geometry.thumbHeight;
      const offset = Math.round((viewport.scrollTop / geometry.scrollRange) * travel);
      thumb.style.height = `${geometry.thumbHeight}px`;
      thumb.style.transform = `translateY(${offset}px)`;
    };
    const scheduleDraw = () => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    const handleScroll = () => {
      scheduleDraw();
      root.dataset.scrolling = '';
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => delete root.dataset.scrolling, SCROLL_IDLE_MS);
    };

    const handleThumbPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const geometry = readGeometry(viewport, track);
      if (!geometry) return;
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      const startScrollTop = viewport.scrollTop;
      const scrollPerPixel = geometry.scrollRange / Math.max(1, geometry.trackHeight - geometry.thumbHeight);
      thumb.setPointerCapture(event.pointerId);
      root.dataset.dragging = '';
      const handleMove = (move: PointerEvent) => {
        viewport.scrollTop = startScrollTop + (move.clientY - startY) * scrollPerPixel;
      };
      const handleRelease = () => {
        delete root.dataset.dragging;
        thumb.removeEventListener('pointermove', handleMove);
        thumb.removeEventListener('pointerup', handleRelease);
        thumb.removeEventListener('pointercancel', handleRelease);
      };
      thumb.addEventListener('pointermove', handleMove);
      thumb.addEventListener('pointerup', handleRelease);
      thumb.addEventListener('pointercancel', handleRelease);
    };
    // A press on the bare track pages toward it, as a native scrollbar does.
    const handleTrackPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== track) return;
      const isAboveThumb = event.clientY < thumb.getBoundingClientRect().top;
      viewport.scrollBy({ top: (isAboveThumb ? -1 : 1) * viewport.clientHeight * 0.9 });
    };

    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(viewport);
    for (const child of viewport.children) observer.observe(child);
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    thumb.addEventListener('pointerdown', handleThumbPointerDown);
    track.addEventListener('pointerdown', handleTrackPointerDown);
    scheduleDraw();

    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', handleScroll);
      thumb.removeEventListener('pointerdown', handleThumbPointerDown);
      track.removeEventListener('pointerdown', handleTrackPointerDown);
      if (frame !== 0) cancelAnimationFrame(frame);
      window.clearTimeout(idleTimer);
      delete root.dataset.scrolling;
      delete root.dataset.dragging;
    };
  }, []);

  return (
    <div ref={rootRef} className={clsx(styles['root'], className)}>
      <div ref={viewportRef} className={clsx(styles['viewport'], viewportClassName)}>{children}</div>
      <div ref={trackRef} className={styles['track']} aria-hidden="true" hidden>
        <div ref={thumbRef} className={styles['thumb']} />
      </div>
    </div>
  );
}
