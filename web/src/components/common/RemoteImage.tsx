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

const MAX_SETTLED_SOURCES = 512;
const settledSources = new Set<string>();

/** Clears session-cached mark URLs so non-isolated test runs start from a clean slate. */
export function resetSettledRemoteSources(): void {
  settledSources.clear();
}

function rememberSettledSource(src: string): void {
  if (settledSources.has(src)) return;
  if (settledSources.size >= MAX_SETTLED_SOURCES) {
    const oldest = settledSources.values().next().value;
    if (oldest !== undefined) settledSources.delete(oldest);
  }
  settledSources.add(src);
}

/** Inline bytes (`data:`, `blob:`) are read from memory rather than fetched over a link. */
function isInline(src: string): boolean {
  return /^(?:data|blob):/i.test(src);
}

function FetchedMark({ src, size, isMasked = false, className, style, loading = 'eager', onError }: RemoteImageProps) {
  const isFetched = !isInline(src);
  const [isReady, setIsReady] = React.useState(() => !isFetched || settledSources.has(src));
  const image = React.useRef<HTMLImageElement>(null);
  // The probe outlives a re-render: a caller's fresh handler is what it reports to, not a stale one.
  const reportedError = React.useRef(onError);
  React.useLayoutEffect(() => {
    reportedError.current = onError;
  }, [onError]);

  // A cached source is complete before the first paint, so it is drawn without ever showing the
  // placeholder. Once proven ready in this session, recycled virtual-list rows render it in a
  // single pass without mounting a placeholder or forcing a second layout-effect commit.
  React.useLayoutEffect(() => {
    const mark = image.current;
    if (!mark?.complete) return undefined;
    setIsReady(true);
    if (mark.naturalWidth > 0) {
      rememberSettledSource(src);
      return undefined;
    }
    let isCurrent = true;
    mark.decode().then(
      () => {
        if (isCurrent) rememberSettledSource(src);
      },
      () => {
        settledSources.delete(src);
        if (isCurrent) reportedError.current?.();
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [src]);

  // A mask is fetched by CSS, which reports nothing back; the probe is what the box can wait on,
  // and stays active even for previously settled URLs (without resetting readiness) so a source
  // that starts failing mid-session still reaches `onError` and falls back.
  React.useLayoutEffect(() => {
    if (!isMasked || !isFetched) return undefined;
    const probe = new Image();
    // The probe speaks for the same rule as the drawn mark: no console address reaches a source
    // that was merely asked to render.
    probe.referrerPolicy = 'no-referrer';
    const settle = () => {
      rememberSettledSource(src);
      setIsReady(true);
    };
    probe.onload = settle;
    probe.onerror = () => {
      settledSources.delete(src);
      setIsReady(true);
      reportedError.current?.();
    };
    probe.src = src;
    if (probe.complete && probe.naturalWidth > 0) settle();
    return () => {
      probe.onload = null;
      probe.onerror = null;
    };
  }, [src, isFetched, isMasked]);

  const reveal = () => {
    rememberSettledSource(src);
    setIsReady(true);
  };
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
            settledSources.delete(src);
            setIsReady(true);
            onError?.();
          }}
        />
      )}
    </span>
  );
}
