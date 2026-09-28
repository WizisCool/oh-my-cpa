import React from 'react';
import clsx from 'clsx';
import { Tooltip } from 'antd';
import { StatusLabel, type StatusTone } from './StatusLabel';
import styles from './StatTiles.module.css';

export interface StatTile<K extends string> {
  key: K;
  label: React.ReactNode;
  /** `undefined` while the count is not known yet; drawn as a dash rather than as zero. */
  count: number | undefined;
  /** `neutral` draws the label as plain text: the tile that means "everything" carries no verdict. */
  tone: StatusTone;
  /** What the tile counts, when its label alone does not say. */
  hint?: React.ReactNode;
}

export interface StatTilesProps<K extends string> {
  tiles: readonly StatTile<K>[];
  selected: K;
  onSelect: (key: K) => void;
  /** Names the group for assistive technology: the filter the tiles set. */
  ariaLabel: string;
  /** The strip's test id. */
  testId?: string;
  /** Each tile's test id is this prefix, a dash and the tile's key. */
  tileTestIdPrefix?: string;
  className?: string;
}

/**
 * A strip of counted tiles that doubles as the list's filter.
 *
 * One component rather than markup per page because the audit trail and the provider list both
 * summarise their rows this way, and two copies of the strip would drift apart in exactly the
 * details (the pressed state, the tone of a non-zero count) a reader moving between the pages
 * compares. A count paints in its tone only when it is non-zero: an empty "failed" is good news
 * and must not look like an alarm.
 */
export function StatTiles<K extends string>({ tiles, selected, onSelect, ariaLabel, testId, tileTestIdPrefix, className }: StatTilesProps<K>) {
  return (
    <div
      className={clsx(styles['stat-tiles'], className)}
      style={{ '--stat-tile-count': tiles.length } as React.CSSProperties}
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {tiles.map((tile) => {
        const isToned = tile.tone !== 'neutral' && tile.tone !== 'accent' && (tile.count ?? 0) > 0;
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
              {tile.tone === 'neutral' ? tile.label : <StatusLabel tone={tile.tone}>{tile.label}</StatusLabel>}
            </span>
            <span className={clsx(styles['stat-tile-value'], isToned && styles[`stat-${tile.tone}`])}>
              {tile.count === undefined ? '—' : tile.count.toLocaleString()}
            </span>
          </button>
        );
        return tile.hint ? <Tooltip key={tile.key} title={tile.hint}>{button}</Tooltip> : button;
      })}
    </div>
  );
}
