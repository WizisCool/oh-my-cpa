import React from 'react';
import clsx from 'clsx';
import { Segmented } from '@/components/ui/segmented';
import { MetaLine } from '../../../components/common/MetaLine';
import { tipCard } from '../../../components/common/tipCard';
import { useT } from '../../../i18n';
import type { MessageKey } from '../../../i18n/catalog';
import { formatCacheRate } from '../../../theme/cacheScale';
import { formatTokens, formatTokensFull } from '../../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import {
  anatomyCacheRate,
  anatomyReasoningShare,
  TOKEN_SCOPES,
  type TokenAnatomy,
  type TokenScope,
} from '../../../types/insightsCube';
import { formatShare } from '../../../types/insightsFormat';
import styles from '../insights.module.css';

const PARTS: ReadonlyArray<{ key: keyof TokenAnatomy; label: MessageKey; color: string }> = [
  { key: 'cacheRead', label: 'insights.anatomy.cache_read', color: 'var(--series-1)' },
  { key: 'cacheWrite', label: 'insights.anatomy.cache_write', color: 'var(--series-2)' },
  { key: 'uncachedInput', label: 'insights.anatomy.uncached_input', color: 'var(--series-3)' },
  { key: 'regularOutput', label: 'insights.anatomy.regular_output', color: 'var(--series-4)' },
  { key: 'reasoningOutput', label: 'insights.anatomy.reasoning', color: 'var(--series-5)' },
];

interface TokenAnatomyStripProps {
  anatomy: TokenAnatomy;
  /** With a scope the strip is the page's token-scope switch; without one it is a drawer's reading. */
  scope?: TokenScope;
  onScopeChange?: (scope: TokenScope) => void;
  isCompact?: boolean;
  testId?: string;
}

/**
 * Where the tokens went: the selection's tokens cut into five parts that never overlap, so a total
 * swollen by cache reads is told apart from one that paid for its prompt. On the page it also
 * switches what the token metric counts; the cache-read rate and the reasoning share are read off
 * the same parts.
 */
export const TokenAnatomyStrip: React.FC<TokenAnatomyStripProps> = ({ anatomy, scope, onScopeChange, isCompact = false, testId }) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const whole = PARTS.reduce((sum, part) => sum + anatomy[part.key], 0);
  const reasoningShare = anatomyReasoningShare(anatomy);
  const facts = (
    <MetaLine>
      <span>{t('insights.anatomy.cache_rate')} <b>{formatCacheRate(anatomyCacheRate(anatomy))}</b></span>
      <span>{t('insights.anatomy.reasoning_share')} <b>{reasoningShare === null ? '—' : formatShare(reasoningShare / 100)}</b></span>
    </MetaLine>
  );
  return (
    <div className={clsx(styles['anatomy'], isCompact && styles['anatomy-compact'])} data-testid={testId}>
      <div className={styles['anatomy-head']}>
        {scope !== undefined && onScopeChange ? (
          <span className={styles['anatomy-title']}>
            <span>{t('insights.anatomy.title')}</span>
            <Segmented<TokenScope>
              size="sm"
              value={scope}
              onChange={onScopeChange}
              aria-label={t('insights.anatomy.scope_label')}
              data-testid="insights-token-scope"
              options={TOKEN_SCOPES.map((value) => ({ value, label: t(`insights.anatomy.scope.${value}`) }))}
            />
          </span>
        ) : (
          <span className={styles['anatomy-title']}>{t('insights.anatomy.title')}</span>
        )}
        {/* A drawer lists these rates among its facts already. */}
        {!isCompact && facts}
      </div>
      <div className={styles['anatomy-bar']} role="img" aria-label={t('insights.anatomy.title')}>
        {whole > 0 && PARTS.map((part) => (anatomy[part.key] > 0 ? (
          <span
            key={part.key}
            style={{ flexGrow: anatomy[part.key], background: part.color }}
            {...tipCard({ heading: t(part.label), rows: [{ value: formatTokensFull(anatomy[part.key]) }, { value: formatShare(anatomy[part.key] / whole) }] })}
          />
        ) : null))}
      </div>
      <ul className={styles['anatomy-legend']}>
        {PARTS.map((part) => (
          <li key={part.key} data-tip={formatTokensFull(anatomy[part.key])}>
            <i style={{ background: part.color }} aria-hidden="true" />
            <span className={styles['anatomy-legend-label']}>{t(part.label)}</span>
            <span className={styles['anatomy-legend-value']}>{formatTokens(anatomy[part.key], style)}</span>
            <span className={styles['anatomy-legend-share']}>{whole > 0 ? formatShare(anatomy[part.key] / whole) : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
