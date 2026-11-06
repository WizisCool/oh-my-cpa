import { PuzzleOutlined } from '../icons';
import { MarkArtwork } from '../common/MarkArtwork';
import { pluginLogoArtworks } from '../../types/pluginOAuthProviders';
import styles from './PluginIcon.module.css';

interface PluginIconProps {
  logo?: string;
  className?: string;
  fallbackSize?: string;
  /** `lazy` for a list that draws many marks at once; a visible mark loads immediately either way. */
  loading?: 'eager' | 'lazy';
}

/**
 * A plugin's mark, drawn from the artwork it publishes.
 *
 * Artwork stays in an isolated `<img>`, so plugin SVG markup cannot enter the host
 * DOM, whether inline or loaded from the publisher's HTTP(S) URL. It is shown as its author drew
 * it, because a registry mark is artwork rather than a glyph: the published logos are opaque
 * badges, gradients and embedded images, and a plugin that follows the console's theme does so
 * from inside its own SVG. Repainting the artwork in the current text colour would flatten
 * those marks into solid blocks.
 */
export function PluginIcon(props: PluginIconProps) {
  // Remounting per source means a failed mark cannot outlive the artwork that replaced it.
  return <PluginArtwork key={props.logo} {...props} />;
}

function PluginArtwork({ logo, className, fallbackSize = '1em', loading }: PluginIconProps) {
  // `size="100%"` rather than a font size: each surface that draws the mark owns its box
  // (the management chip, the rail's glyph slot), and the artwork fills it. A `1em` size here
  // lands as an inline style on the image, which no surface rule could then override, so every
  // published logo was drawn at one text glyph in the middle of a 44-48px chip.
  return <MarkArtwork artworks={pluginLogoArtworks(logo)} size="100%" loading={loading} fallback={<PuzzleOutlined size={fallbackSize} />}>
    {(artwork, content) => <span
      className={[styles.icon, className].filter(Boolean).join(' ')}
      aria-hidden="true"
      data-plugin-logo={!artwork ? 'fallback' : /^data:image\/svg\+xml[;,]/i.test(artwork.url) ? 'svg' : 'image'}
    >{content}</span>}
  </MarkArtwork>;
}
