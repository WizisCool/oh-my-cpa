import React from 'react';
import { PuzzleOutlined } from '../icons';
import { isRenderableLogoURL } from '../../types/pluginOAuthProviders';
import styles from './PluginIcon.module.css';

interface PluginIconProps {
  logo?: string;
  className?: string;
  fallbackSize?: string;
}

/**
 * A plugin's mark, drawn from the artwork it publishes.
 *
 * Artwork stays in an isolated `<img>`, so untrusted plugin SVG markup cannot enter the host
 * DOM and the console's CSP only has to allow `data:` images. It is shown as its author drew
 * it, because a registry mark is artwork rather than a glyph: the published logos are opaque
 * badges, gradients and embedded images, and a plugin that follows the console's theme does so
 * from inside its own SVG. Repainting the artwork in the current text colour would flatten
 * those marks into solid blocks.
 */
export function PluginIcon(props: PluginIconProps) {
  // Remounting per source means a failed mark cannot outlive the artwork that replaced it.
  return <PluginArtwork key={props.logo} {...props} />;
}

function PluginArtwork({ logo, className, fallbackSize = '1em' }: PluginIconProps) {
  const source = (logo ?? '').trim();
  const [hasFailed, setHasFailed] = React.useState(false);
  const isDrawable = isRenderableLogoURL(source) && !hasFailed;
  const isSvg = isDrawable && /^data:image\/svg\+xml[;,]/i.test(source);
  const kind = !isDrawable ? 'fallback' : isSvg ? 'svg' : 'image';
  return (
    <span
      className={[styles.icon, className].filter(Boolean).join(' ')}
      aria-hidden="true"
      data-plugin-logo={kind}
    >
      {isDrawable
        ? <img src={source} alt="" onError={() => setHasFailed(true)} />
        : <PuzzleOutlined size={fallbackSize} />}
    </span>
  );
}
