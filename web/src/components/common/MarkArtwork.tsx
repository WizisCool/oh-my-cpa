import React from 'react';
import type { MarkArtwork as Artwork } from '../../types/brandMark';
import { RemoteImage } from './RemoteImage';

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
  const content = artwork ? (
    <RemoteImage
      src={artwork.url}
      size={size}
      isMasked={artwork.isMono}
      className={className}
      style={style}
      loading={loading}
      onError={() => setFailedURLs((failed) => new Set([...failed, artwork.url]))}
    />
  ) : fallback;
  return children ? <>{children(artwork, content)}</> : <>{content}</>;
}
