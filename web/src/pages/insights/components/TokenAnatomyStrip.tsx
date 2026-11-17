import React from 'react';
import { Segmented } from '@/components/ui/segmented';
import { MetaLine } from '../../../components/common/MetaLine';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { RollingNumber } from '../../../components/dashboard/RollingNumber';
import { useT } from '../../../i18n';
import type { MessageKey } from '../../../i18n/catalog';
import { formatCacheRate } from '../../../theme/cacheScale';
import { formatTokensFull, resolveTokenFlowReadout } from '../../../types/tokenDisplay';
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

type AnatomyPart = keyof TokenAnatomy;

const PARTS: ReadonlyArray<{ key: AnatomyPart; label: MessageKey; color: string }> = [
  { key: 'cacheRead', label: 'insights.anatomy.cache_read', color: 'var(--series-1)' },
  { key: 'cacheWrite', label: 'insights.anatomy.cache_write', color: 'var(--series-2)' },
  { key: 'uncachedInput', label: 'insights.anatomy.uncached_input', color: 'var(--series-3)' },
  { key: 'regularOutput', label: 'insights.anatomy.regular_output', color: 'var(--series-4)' },
  { key: 'reasoningOutput', label: 'insights.anatomy.reasoning', color: 'var(--series-5)' },
];

interface TokenAnatomyStripProps {
  anatomy: TokenAnatomy;
  /** With a scope the panel is the page's token-scope switch; without one it is a drawer's reading. */
  scope?: TokenScope;
  onScopeChange?: (scope: TokenScope) => void;
  /** False where the cache-read rate and reasoning share are already listed beside the panel. */
  hasRates?: boolean;
  testId?: string;
}

/**
 * Where the tokens went: the selection's tokens cut into five parts that never overlap, so a total
 * swollen by cache reads is told apart from one that paid for its prompt. On the page it also
 * switches what the token metric counts; the cache-read rate and the reasoning share are read off
 * the same parts.
 *
 * The bar draws the proportions and the columns under it name them, in the bar's order. Pointing at
 * either lights its partner and steps the other parts back, which is how a sliver of the bar is found
 * without a tooltip repeating the column below it. A narrow panel (a drawer, a phone) lists the
 * parts as rows instead.
 */
export const TokenAnatomyStrip: React.FC<TokenAnatomyStripProps> = ({ anatomy, scope, onScopeChange, hasRates = true, testId }) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const [activePart, setActivePart] = React.useState<AnatomyPart | null>(null);
  const whole = PARTS.reduce((sum, part) => sum + anatomy[part.key], 0);
  const reasoningShare = anatomyReasoningShare(anatomy);
  const isDimmed = (part: AnatomyPart) => (activePart !== null && activePart !== part) || undefined;

  const extra = (
    <>
      {hasRates && (
        <MetaLine className={styles['anatomy-rates']}>
          <span>{t('insights.anatomy.cache_rate')} <b>{formatCacheRate(anatomyCacheRate(anatomy))}</b></span>
          <span>{t('insights.anatomy.reasoning_share')} <b>{reasoningShare === null ? '—' : formatShare(reasoningShare / 100)}</b></span>
        </MetaLine>
      )}
      {scope !== undefined && onScopeChange && (
        <Segmented<TokenScope>
          size="sm"
          value={scope}
          onChange={onScopeChange}
          aria-label={t('insights.anatomy.scope_label')}
          data-testid="insights-token-scope"
          options={TOKEN_SCOPES.map((value) => ({ value, label: t(`insights.anatomy.scope.${value}`) }))}
        />
      )}
    </>
  );

  return (
    <Panel
      data-testid={testId}
      title={<PanelTitle extra={hasRates || scope !== undefined ? extra : undefined}>{t('insights.anatomy.title')}</PanelTitle>}
    >
      <div className={styles['anatomy']} onPointerLeave={() => setActivePart(null)}>
        <div className={styles['anatomy-bar']} role="img" aria-label={t('insights.anatomy.title')}>
          {whole > 0 && PARTS.map((part) => (anatomy[part.key] > 0 ? (
            <span
              key={part.key}
              style={{ flexGrow: anatomy[part.key], background: part.color }}
              data-dimmed={isDimmed(part.key)}
              onPointerEnter={() => setActivePart(part.key)}
            />
          ) : null))}
        </div>
        <ul className={styles['anatomy-parts']}>
          {PARTS.map((part) => (
            <li key={part.key} data-dimmed={isDimmed(part.key)} onPointerEnter={() => setActivePart(part.key)}>
              <span className={styles['anatomy-part-name']}>
                <i style={{ background: part.color }} aria-hidden="true" />
                {t(part.label)}
              </span>
              <span className={styles['anatomy-part-reading']}>
                <span className={styles['anatomy-part-value']} data-tip={formatTokensFull(anatomy[part.key])}>
                  <RollingNumber readout={resolveTokenFlowReadout(anatomy[part.key], style)} />
                </span>
                <span className={styles['anatomy-part-share']}>{whole > 0 ? formatShare(anatomy[part.key] / whole) : '—'}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
};
