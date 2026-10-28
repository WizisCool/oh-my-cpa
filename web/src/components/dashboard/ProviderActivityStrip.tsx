import React from 'react';
import { useT } from '../../i18n';
import dayjs from '../../utils/time';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { successRateTone } from '../../types/usageEventMetrics';
import { Tooltip } from '../common/Tooltip';
import type { ActivityBlock } from './dashboardProvidersLogic';

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');
const DAY_MS = 24 * 60 * 60 * 1000;

function formatSpan(block: ActivityBlock, timeZone: string): string {
  const start = dayjs(block.startMs).tz(timeZone);
  const end = dayjs(block.endMs).tz(timeZone);
  // A block inside one day names the day once; a block of a day or more needs both dates.
  if (block.endMs - block.startMs < DAY_MS && start.isSame(end.subtract(1, 'millisecond'), 'day')) {
    return `${start.format('MM-DD HH:mm')} – ${end.format('HH:mm')}`;
  }
  return `${start.format('MM-DD HH:mm')} – ${end.format('MM-DD HH:mm')}`;
}

export interface ProviderActivityStripProps {
  blocks: ActivityBlock[];
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
export const ProviderActivityStrip: React.FC<ProviderActivityStripProps> = ({ blocks, name }) => {
  const t = useT();
  const timeZone = useTimeZone();
  const history = blocks.flatMap((block) => {
    if (block.total <= 0 || block.successRate === null) return [];
    return [{
      key: block.startMs,
      text: `${formatSpan(block, timeZone)} · ${t('dash.providers_activity_block', {
        n: PLAIN_NUMBER_FORMAT.format(block.total),
        rate: `${block.successRate.toFixed(1)}%`,
      })}`,
    }];
  });
  const idleCount = blocks.length - history.length;
  const idleNote = history.length > 0 && idleCount > 0
    ? t('dash.providers_activity_idle_other', { n: idleCount })
    : null;
  const historyText = history.length > 0
    ? `${history.map((reading) => reading.text).join('; ')}${idleNote ? `; ${idleNote}` : ''}`
    : t('dash.providers_activity_idle');
  const historyHint = history.length > 0
    ? (
      <div className="provider-activity-history">
        {history.map((reading) => <div key={reading.key}>{reading.text}</div>)}
        {idleNote && <div>{idleNote}</div>}
      </div>
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
        {blocks.map((block) => {
          const tone = block.successRate === null ? 'idle' : successRateTone(block.successRate);
          const reading = block.successRate === null
            ? t('dash.providers_activity_idle')
            : t('dash.providers_activity_block', {
              n: PLAIN_NUMBER_FORMAT.format(block.total),
              rate: `${block.successRate.toFixed(1)}%`,
            });
          return (
            <Tooltip
              key={block.startMs}
              title={(
                <>
                  <div>{formatSpan(block, timeZone)}</div>
                  <div>{reading}</div>
                </>
              )}
            >
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
};
