import React from 'react';
import type { MarkArtwork as Artwork } from '../../types/brandMark';

export interface MarkArtworkProps {
  artworks: readonly Artwork[];
  size: number | string;
  fallback: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  loading?: 'eager' | 'lazy';
  children?: (artwork: Artwork | undefined, content: React.ReactNode) => React.ReactNode;
}

/** Failed sources belong to one candidate list; republished artwork starts with a clean slate. */
export function MarkArtwork(props: MarkArtworkProps) {
  return <ArtworkCandidates key={props.artworks.map((artwork) => artwork.url).join('\n')} {...props} />;
}

function ArtworkCandidates({ artworks, size, fallback, className, style, loading = 'eager', children }: MarkArtworkProps) {
  const [failedURLs, setFailedURLs] = React.useState<ReadonlySet<string>>(() => new Set());
  const artwork = artworks.find((candidate) => !failedURLs.has(candidate.url));
  let content = fallback;
  if (artwork?.isMono) {
    const { color, ...restStyle } = style ?? {};
    content = <span aria-hidden="true" className={className} style={{
      display: 'inline-block', width: size, height: size, flex: 'none',
      backgroundColor: color ?? 'var(--fg)',
      mask: `url("${artwork.url}") center / contain no-repeat`,
      WebkitMask: `url("${artwork.url}") center / contain no-repeat`,
      ...restStyle,
    }} />;
  } else if (artwork) {
    content = <img src={artwork.url} alt="" width={typeof size === 'number' ? size : undefined} height={typeof size === 'number' ? size : undefined} className={className}
      style={{ display: 'block', objectFit: 'contain', width: size, height: size, ...style }} loading={loading} decoding="async"
      onError={() => setFailedURLs((failed) => new Set([...failed, artwork.url]))} />;
  }
  return children ? <>{children(artwork, content)}</> : <>{content}</>;
}
