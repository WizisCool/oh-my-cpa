import React from 'react';
import { useT } from '../../i18n';
import dayjs from '../../utils/time';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { successRateTone } from '../../types/usageEventMetrics';
import { Tooltip } from '../common/Tooltip';
import type { ActivityBlock } from './dashboardProvidersLogic';

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');
const DAY_MS = 24 * 60 * 60 * 1000;

function formatSpan(block: ActivityBlock): string {
  const start = dayjs(block.startMs);
  const end = dayjs(block.endMs);
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
  // The hints print wall-clock times in the console's zone, and must re-render when it changes.
  useTimeZone();
  const latest = blocks.reduce<ActivityBlock | null>(
    (current, block) => (block.total > 0 ? block : current),
    null,
  );
  const latestReading = latest && latest.successRate !== null
    ? t('dash.providers_activity_latest', {
      reading: `${formatSpan(latest)} · ${t('dash.providers_activity_block', {
        n: PLAIN_NUMBER_FORMAT.format(latest.total),
        rate: `${latest.successRate.toFixed(1)}%`,
      })}`,
    })
    : t('dash.providers_activity_idle');
  return (
    <div
      className="provider-activity"
      role="img"
      aria-label={`${t('dash.providers_activity', { name })}: ${latestReading}`}
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
                <div>{formatSpan(block)}</div>
                <div>{reading}</div>
              </>
            )}
          >
            {/* A block is a reading, not a second action for the row it sits in: tapping it
                opens its hint instead of following the row to provider management. */}
            <span
              className={`provider-activity-block tone-${tone}`}
              onClick={(event) => event.stopPropagation()}
            />
          </Tooltip>
        );
      })}
    </div>
  );
};
