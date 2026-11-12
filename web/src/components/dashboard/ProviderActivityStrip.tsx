import React from 'react';
import { useT } from '../../i18n';
import { successRateTone } from '../../types/usageEventMetrics';
import { Tooltip, TooltipReadout } from '../common/Tooltip';
import type { ActivityBlock } from './dashboardProvidersLogic';

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');
export interface ProviderActivityStripProps {
  blocks: ActivityBlock[];
  labels: readonly string[];
  /** The row's name, for the strip's accessible label. */
  name: string;
}

/**
 * A provider's window as a row of blocks, oldest on the left and the present on the right.
 *
 * The window rate beside it averages the present into the past: a provider that served all day
 * and has failed for the last hour still reads green. Each block is one bucket, coloured by the
 * console's one success-rate band, so where in the window the failures sit is visible at a glance.
 * An idle bucket is a plain track, never a band colour: no traffic is not a verdict.
 */
export const ProviderActivityStrip = React.memo(function ProviderActivityStrip({ blocks, labels, name }: ProviderActivityStripProps) {
  const t = useT();
  const history = React.useMemo(() => blocks.flatMap((block, index) => {
    if (block.total <= 0 || block.successRate === null) return [];
    const requests = PLAIN_NUMBER_FORMAT.format(block.total);
    const rate = `${block.successRate.toFixed(1)}%`;
    return [{
      key: block.startMs,
      label: labels[index],
      requests,
      rate,
      tone: successRateTone(block.successRate),
      text: `${labels[index]}: ${t('dash.providers_activity_block', { n: requests, rate })}`,
    }];
  }), [blocks, labels, t]);
  const idleCount = blocks.length - history.length;
  const idleNote = history.length > 0 && idleCount > 0
    ? t('dash.providers_activity_idle_other', { n: idleCount })
    : null;
  const historyText = history.length > 0
    ? `${history.map((reading) => reading.text).join('; ')}${idleNote ? `; ${idleNote}` : ''}`
    : t('dash.providers_activity_idle');
  // The keyboard reading of the whole window: one row per active bucket, its time on the left and
  // the request count and success rate as two aligned columns on the right.
  const historyHint = () => history.length > 0
    ? (
      <TooltipReadout
        className="provider-activity-history"
        heading={t('dash.providers_activity', { name })}
        rows={history.map((reading) => ({
          key: String(reading.key),
          name: reading.label,
          value: reading.requests,
          share: <span className={reading.tone === 'warn' ? 'text-warn' : reading.tone === 'danger' ? 'text-danger' : undefined}>{reading.rate}</span>,
        }))}
        notes={idleNote ? [idleNote] : undefined}
      />
    )
    : t('dash.providers_activity_idle');
  return (
    <Tooltip
      title={historyHint}
      isFocusOnly
      classNames={{ root: 'provider-activity-history-tooltip' }}
    >
      {/* One focus stop gives keyboard and screen-reader users the whole history without turning
          two dozen decorative blocks into two dozen tab stops. A pointer reads one block at a
          time: the gaps between blocks belong to the strip, so a hover hint here would open over
          the reading of the block the pointer crossed onto. */}
      <div
        className="provider-activity"
        role="img"
        tabIndex={0}
        aria-label={`${t('dash.providers_activity', { name })}: ${historyText}`}
      >
        {blocks.map((block, index) => {
          const tone = block.successRate === null ? 'idle' : successRateTone(block.successRate);
          const card = block.successRate === null
            ? { heading: labels[index], notes: [t('dash.providers_activity_idle')] }
            : {
              heading: labels[index],
              rows: [
                { label: t('dash.providers_activity_requests'), value: PLAIN_NUMBER_FORMAT.format(block.total) },
                {
                  label: t('dash.success_rate_short'),
                  value: `${block.successRate.toFixed(1)}%`,
                  tone: tone === 'warn' || tone === 'danger' ? tone : undefined,
                },
              ],
            };
          return (
            <Tooltip key={block.startMs} card={card}>
              {/* A block is a reading, not a second action for the row it sits in: tapping it
                  opens its hint instead of following the row to provider management. */}
              <span
                aria-hidden="true"
                className={`provider-activity-block tone-${tone}`}
                onClick={(event) => event.stopPropagation()}
              />
            </Tooltip>
          );
        })}
      </div>
    </Tooltip>
  );
});
