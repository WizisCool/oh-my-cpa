import React from 'react';
import { PuzzleOutlined } from '../icons';
import { isRenderableLogoURL } from '../../types/pluginOAuthProviders';
import styles from './PluginIcon.module.css';

interface PluginIconProps {
  logo?: string;
  className?: string;
  fallbackSize?: string;
}

/** SVG stays in image context, so untrusted plugin markup cannot enter the host DOM. */
export function PluginIcon(props: PluginIconProps) {
  return <PluginArtwork key={props.logo} {...props} />;
}

function PluginArtwork({ logo, className, fallbackSize = '1em' }: PluginIconProps) {
  const source = (logo ?? '').trim();
  const [hasFailed, setHasFailed] = React.useState(false);
  const isDrawable = isRenderableLogoURL(source) && !hasFailed;
  const isSvg = isDrawable && /^data:image\/svg\+xml[;,]/i.test(source);
  React.useEffect(() => {
    if (!isSvg) return;
    // CSS masks expose no error event; an isolated image keeps broken-artwork fallback intact.
    const image = new Image();
    image.onerror = () => setHasFailed(true);
    image.src = source;
    return () => { image.onerror = null; };
  }, [isSvg, source]);
  const kind = isSvg ? 'svg' : isDrawable ? 'image' : 'fallback';
  const mask = isSvg ? `url(${JSON.stringify(source)})` : undefined;
  return (
    <span
      className={[styles.icon, isSvg && styles.glyph, className].filter(Boolean).join(' ')}
      aria-hidden="true"
      data-plugin-logo={kind}
      style={isSvg ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {!isSvg && (isDrawable
        ? <img src={source} alt="" onError={() => setHasFailed(true)} />
        : <PuzzleOutlined size={fallbackSize} />)}
    </span>
  );
}
