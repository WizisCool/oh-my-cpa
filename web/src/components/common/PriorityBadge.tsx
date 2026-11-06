import { useT } from '../../i18n';
import { StepsOutlined } from '../icons';
import { GlyphBadge, GlyphBadgeSecondary } from './GlyphBadge';

export interface PriorityBadgeProps {
  priority?: number;
  /** A routing weight; printed only where it departs from CPA's default of 1. */
  weight?: number;
  isStatic?: boolean;
}

/**
 * A routing priority as a badge beside a name, with a non-default weight after it. Nothing renders
 * when there is no priority and the weight is the default.
 */
export function PriorityBadge({ priority, weight, isStatic }: PriorityBadgeProps) {
  const t = useT();
  const hasWeight = weight !== undefined && weight !== 1;
  if (priority === undefined && !hasWeight) return null;
  const label = [
    t('omc.priority_value', { n: priority ?? 0 }),
    weight !== undefined ? t('omc.weight_value', { n: weight }) : '',
  ].filter(Boolean).join(' · ');
  return (
    <GlyphBadge glyph={<StepsOutlined />} label={label} hint={t('omc.priority_badge_hint')} isStatic={isStatic} data-priority-badge="true">
      <span>{priority ?? 0}</span>
      {hasWeight && <GlyphBadgeSecondary>×{weight}</GlyphBadgeSecondary>}
    </GlyphBadge>
  );
}
