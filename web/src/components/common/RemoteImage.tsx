import React from 'react';
import { Placeholder } from './Placeholder';
import styles from './RemoteImage.module.css';

export interface RemoteImageProps {
  /** The artwork's source. Inline bytes are already here, so they are not held behind a placeholder. */
  src: string;
  /** The box the mark occupies; the placeholder fills it, so the row does not move when the mark lands. */
  size: number | string;
  /** Draws the source as an isolated mask in the current text colour rather than as its own image. */
  isMasked?: boolean;
  className?: string;
  style?: React.CSSProperties;
  loading?: 'eager' | 'lazy';
  /** The source cannot be drawn, so the caller can offer the next candidate or its fallback. */
  onError?: () => void;
}

/**
 * A mark the browser fetches by URL: a publisher's logo, catalog artwork or an uploaded icon.
 *
 * Its bytes arrive after the row that names it, so the mark's box is held by the console's
 * first-load placeholder rather than standing empty. Artwork already in the browser's cache never
 * shows it, and an inline source has nothing to wait for. The box is the mark's layout slot, which
 * is why the caller's `className` and `style` land on it: a mark is never the thing that shrinks
 * or drifts while the row it belongs to settles around it.
 */
export function RemoteImage(props: RemoteImageProps) {
  // State belongs to one source: a mark that failed cannot leave the next candidate already drawn.
  return <FetchedMark key={props.src} {...props} />;
}

/** Inline bytes (`data:`, `blob:`) are read from memory rather than fetched over a link. */
function isInline(src: string): boolean {
  return /^(?:data|blob):/i.test(src);
}

function FetchedMark({ src, size, isMasked = false, className, style, loading = 'eager', onError }: RemoteImageProps) {
  const isFetched = !isInline(src);
  const [isReady, setIsReady] = React.useState(() => !isFetched);
  const image = React.useRef<HTMLImageElement>(null);
  // The probe outlives a re-render: a caller's fresh handler is what it reports to, not a stale one.
  const reportedError = React.useRef(onError);
  React.useLayoutEffect(() => {
    reportedError.current = onError;
  }, [onError]);

  // A cached source is complete before the first paint, so it is drawn without ever showing the
  // placeholder. A failed one releases its box here too, but a source cached as broken may not
  // repeat its error event on a new element, so the browser's own decode outcome is what tells the
  // caller to offer its next candidate. Only a mark that reports no dimensions is asked: a valid
  // SVG may report none in some engines, and decoding it still succeeds.
  React.useLayoutEffect(() => {
    const mark = image.current;
    if (!mark?.complete) return undefined;
    setIsReady(true);
    if (mark.naturalWidth > 0) return undefined;
    let isCurrent = true;
    mark.decode().catch(() => {
      if (isCurrent) reportedError.current?.();
    });
    return () => {
      isCurrent = false;
    };
  }, [src]);

  // A mask is fetched by CSS, which reports nothing back; the probe is what the box can wait on.
  React.useLayoutEffect(() => {
    if (!isMasked || !isFetched) return undefined;
    const probe = new Image();
    // The probe speaks for the same rule as the drawn mark: no console address reaches a source
    // that was merely asked to render.
    probe.referrerPolicy = 'no-referrer';
    const settle = () => setIsReady(true);
    probe.onload = settle;
    probe.onerror = () => {
      setIsReady(true);
      reportedError.current?.();
    };
    probe.src = src;
    // A mask already in the browser's cache is complete the moment the probe asks for it, so it is
    // drawn without the placeholder the first pass would otherwise show. A failed cached source has
    // no dimensions and stays pending until its error is reported below.
    if (probe.complete && probe.naturalWidth > 0) setIsReady(true);
    return () => {
      probe.onload = null;
      probe.onerror = null;
    };
  }, [src, isFetched, isMasked]);

  const reveal = () => setIsReady(true);
  return (
    <span
      className={[styles.frame, className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, ...style }}
      data-remote-image={isReady ? 'loaded' : 'loading'}
    >
      {!isReady && <Placeholder width="100%" height="100%" className={styles.skeleton} />}
      {isMasked ? (
        <span
          aria-hidden="true"
          className={styles.mark}
          style={{
            backgroundColor: style?.color ?? 'var(--fg)',
            mask: `url("${src}") center / contain no-repeat`,
            WebkitMask: `url("${src}") center / contain no-repeat`,
          }}
        />
      ) : (
        <img
          ref={image}
          className={styles.mark}
          src={src}
          alt=""
          width={typeof size === 'number' ? size : undefined}
          height={typeof size === 'number' ? size : undefined}
          loading={loading}
          decoding="async"
          // A publisher learns nothing about the console's address from artwork it was asked to serve.
          referrerPolicy="no-referrer"
          onLoad={reveal}
          onError={() => {
            setIsReady(true);
            onError?.();
          }}
        />
      )}
    </span>
  );
}
