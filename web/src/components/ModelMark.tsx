import React from 'react';
import { modelMarkIconId, type ModelReference } from '../types/modelSquare';
import { BoxOutlined } from './icons';
import { LobeIcon } from './LobeIcon';

export interface ModelMarkProps {
  /** The model identity or call point to resolve the brand/manufacturer mark for. */
  model?: string;
  /** Legacy alias for model. */
  callPoint?: string;
  /** Optional metadata from model reference / models.dev. */
  metadata?: ModelReference;
  /**
   * Fallback model name to try if the primary model produces no manufacturer/brand icon
   * (e.g. When the primary is a custom call point/alias, fallback to the requested model).
   */
  fallbackModel?: string;
  /** Size in pixels (width and height). Defaults to 16. */
  size?: number;
  /** Optional custom CSS class. */
  className?: string;
  /** Optional custom inline style. */
  style?: React.CSSProperties;
}

/**
 * ModelMark renders the maker's brand mark for a model identity or call point,
 * using the same resolution rules as Model Square.
 *
 * A name with no maker falls back to the upstream it routes to, then to a neutral glyph.
 */
export const ModelMark: React.FC<ModelMarkProps> = React.memo(({
  model,
  callPoint,
  metadata,
  fallbackModel,
  size = 16,
  className,
  style,
}) => {
  const primary = model ?? callPoint ?? '';
  const iconId = React.useMemo(
    () => modelMarkIconId(primary, fallbackModel, metadata),
    [primary, fallbackModel, metadata],
  );

  if (iconId) {
    return (
      <span
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: size,
          height: size,
          ...style,
        }}
        aria-hidden="true"
      >
        <LobeIcon iconId={iconId} size={size} />
      </span>
    );
  }

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: size,
        height: size,
        color: 'var(--muted)',
        opacity: 0.7,
        ...style,
      }}
      aria-hidden="true"
    >
      <BoxOutlined size={size} strokeWidth={1.5} />
    </span>
  );
});
