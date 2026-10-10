import React from 'react';
import { resolveModelManufacturer, type ModelReference } from '../types/modelSquare';
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
 * Robust and decoupled:
 * - Safely handles unknown, empty, or unparseable names without throwing.
 * - Supports fallback resolution (e.g., custom alias falling back to requested upstream model).
 * - Falls back to a clean neutral glyph when no brand icon is available.
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
  const primary = (model ?? callPoint ?? '').trim();
  const fallback = (fallbackModel ?? '').trim();

  const iconId = React.useMemo(() => {
    if (primary) {
      try {
        const maker = resolveModelManufacturer(primary, metadata);
        const candidate = maker.modelIconId || maker.iconId;
        if (candidate) return candidate;
      } catch {
        // Safe fallback
      }
    }
    if (fallback && fallback !== primary) {
      try {
        const fallbackMaker = resolveModelManufacturer(fallback);
        const candidate = fallbackMaker.modelIconId || fallbackMaker.iconId;
        if (candidate) return candidate;
      } catch {
        // Safe fallback
      }
    }
    return undefined;
  }, [primary, metadata, fallback]);

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
