import React from 'react';
import { Button } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type { EventFilterKey } from '../../types/usageEventQuery';
import { activeFilterCount } from '../../types/usageEventQuery';

/** How one chip names itself, given the raw committed value. */
export interface ChipDescriptor {
  label: string;
  /** A value the raw parameter cannot express, e.g. a resolved field name. */
  display?: string;
}

export interface RequestFilterChipsProps {
  committed: Partial<Record<EventFilterKey, string[]>>;
  describe: (key: EventFilterKey, values: string[]) => ChipDescriptor;
  /** Removes one dimension, or one value inside a multi-value dimension. */
  onRemove: (key: EventFilterKey, value?: string) => void;
  onClearAll: () => void;
  resolvedWindow?: string;
}

/**
 * The active filter bar.
 *
 * Every committed dimension appears here, including ones the operator set from
 * the always-visible bar, and each chip removes exactly what it names. A
 * multi-value dimension renders one chip per value rather than a single summary
 * chip: "Model: 3" cannot be pruned, so the operator would have to reopen the
 * panel and hunt for which of the three they meant.
 */
export const RequestFilterChips: React.FC<RequestFilterChipsProps> = ({
  committed,
  describe,
  onRemove,
  onClearAll,
}) => {
  const t = useT();
  const keys = Object.keys(committed) as EventFilterKey[];
  if (keys.length === 0) return null;

  return (
    <div className="req-active-chips-bar" aria-label={t('events.active_filters')}>
      <span className="req-active-chips-label">{t('events.active_filters')}</span>
      <div className="req-active-chips-list">
        {keys.map((key) =>
          (committed[key] ?? []).map((value) => {
            const descriptor = describe(key, [value]);
            const label = descriptor.display ?? descriptor.label;
            return (
              <span className="req-filter-chip" key={`${key}:${value}`}>
                <span className="req-filter-chip-text">{label}</span>
                <button
                  type="button"
                  className="req-filter-chip-remove"
                  aria-label={t('events.remove_filter', { filter: label })}
                  onClick={() => onRemove(key, value)}
                >
                  <CloseOutlined />
                </button>
              </span>
            );
          }),
        )}
        <Button size="small" type="link" className="req-clear-all-chips" onClick={onClearAll}>
          {t('events.clear_all')}
        </Button>
      </div>
      <span className="req-active-chips-count" aria-hidden="true">
        {activeFilterCount(committed)}
      </span>
    </div>
  );
};
