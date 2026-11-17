import React from 'react';
import clsx from 'clsx';

import { StatusLabel, type StatusTone } from './StatusLabel';
import styles from './StatTiles.module.css';
import { Tooltip } from './Tooltip';
import { useSelectionThumb } from '@/components/ui/selection-thumb';

export interface StatTile<K extends string> {
  key: K;
  label: React.ReactNode;
  /**
   * The tile's reading. A number is a count: printed grouped, and in the tile's tone once it is
   * non-zero. Anything else is a reading the caller already formatted (a rolling figure, a price).
   * `undefined` is not known yet and is drawn as a dash rather than as zero.
   */
  value: number | React.ReactNode | undefined;
  /** `neutral` draws the label as plain text: the tile that means "everything" carries no verdict. */
  tone?: StatusTone;
  /** A quiet line under the reading, such as its change against an earlier window. */
  foot?: React.ReactNode;
  /** What the tile counts, when its label alone does not say. */
  hint?: React.ReactNode;
}

export interface StatTilesProps<K extends string> {
  tiles: readonly StatTile<K>[];
  selected: K;
  onSelect: (key: K) => void;
  /** Names the group for assistive technology: what the tiles choose. */
  ariaLabel: string;
  /**
   * How the strip sits on a phone. `segmented` folds a filter into one segmented control, label and
   * count on a line; `grid` keeps the cards, two to a row, for readings that are the page's content.
   */
  phoneLayout?: 'segmented' | 'grid';
  /** The strip's test id. */
  testId?: string;
  /** Each tile's test id is this prefix, a dash and the tile's key. */
  tileTestIdPrefix?: string;
  className?: string;
}

/**
 * A strip of tiles, each a reading that doubles as a choice: the filter over a list below it, or the
 * metric a chart below plots.
 *
 * One component rather than markup per page because the audit trail, the provider and key lists and
 * the Insights headline all summarise their page this way, and copies of the strip would drift apart
 * in exactly the details (the pressed state, the tone of a non-zero count, the figure's type) a
 * reader moving between the pages compares. A count paints in its tone only when it is non-zero: an
 * empty "failed" is good news and must not look like an alarm.
 */
export function StatTiles<K extends string>({
  tiles, selected, onSelect, ariaLabel, phoneLayout = 'segmented', testId, tileTestIdPrefix, className,
}: StatTilesProps<K>) {
  // On a phone a filter strip is a segmented control, and its selection glides like every other one.
  const thumbRef = useSelectionThumb<HTMLDivElement>('[aria-pressed="true"]', 'aria-pressed');
  const isSegmentedOnPhone = phoneLayout === 'segmented';
  return (
    <div
      ref={isSegmentedOnPhone ? thumbRef : undefined}
      className={clsx(isSegmentedOnPhone && 'omc-thumb-host', styles['stat-tiles'], className)}
      style={{ '--stat-tile-count': tiles.length } as React.CSSProperties}
      data-phone={phoneLayout}
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {tiles.map((tile) => {
        const tone = tile.tone ?? 'neutral';
        const isCount = typeof tile.value === 'number';
        const isToned = isCount && tone !== 'neutral' && tone !== 'accent' && (tile.value as number) > 0;
        const button = (
          <button
            key={tile.key}
            type="button"
            className={clsx(styles['stat-tile'], selected === tile.key && styles['stat-tile-active'])}
            aria-pressed={selected === tile.key}
            onClick={() => onSelect(tile.key)}
            data-testid={tileTestIdPrefix ? `${tileTestIdPrefix}-${tile.key}` : undefined}
          >
            <span className={styles['stat-tile-label']}>
              {tone === 'neutral' ? tile.label : <StatusLabel tone={tone}>{tile.label}</StatusLabel>}
            </span>
            <span className={clsx(styles['stat-tile-value'], isToned && styles[`stat-${tone}`])}>
              {tile.value === undefined ? '—' : isCount ? (tile.value as number).toLocaleString() : tile.value}
            </span>
            {tile.foot !== undefined && <span className={styles['stat-tile-foot']}>{tile.foot}</span>}
          </button>
        );
        return tile.hint ? <Tooltip key={tile.key} title={tile.hint}>{button}</Tooltip> : button;
      })}
    </div>
  );
}
