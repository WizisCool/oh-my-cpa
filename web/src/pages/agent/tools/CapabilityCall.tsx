import React from 'react';
import { clsx } from 'clsx';
import { LoadingOutlined, WarningOutlined } from '../../../components/icons';
import { useI18n } from '../../../i18n';
import { capabilityTitle } from '../../../i18n/capabilities';
import type { Trace } from '../../../agent/types';
import { argumentSummary, callDuration, callStatusKey, formatDuration, statusTone } from '../state';
import { LiveElapsed } from '../../../components/workspace/LiveElapsed';
import styles from '../AgentPage.module.css';

export interface CapabilityCallProps {
  trace: Trace;
  isSelected: boolean;
  onSelect: (id: string) => void;
  /** Drawn under the row: an approval card. */
  children?: React.ReactNode;
}

/**
 * One capability call as one row: a status mark, the call's title in the operator's language, its
 * identifier, the arguments in brief, and how long it took.
 *
 * The row appears the moment the call starts, before it has a result, so a slow capability reads
 * as running rather than as nothing happening. Arguments and permitted results are one click away
 * in the side panel's details tab; the transcript keeps only what an operator scans.
 */
export const CapabilityCall = React.memo(function CapabilityCall({ trace, isSelected, onSelect, children }: CapabilityCallProps) {
  const { t } = useI18n();
  const isRunning = trace.result.status === 'running';
  const tone = statusTone(trace.result.status, trace.result.code);
  const duration = callDuration(trace);
  const summary = argumentSummary(trace.arguments);
  const title = capabilityTitle(trace.name, t);
  const needsAttention = tone === 'warning';
  return (
    <div className={clsx(styles['call'], isSelected && styles['is-selected'])} data-testid="agent-trace" data-status={trace.result.status}>
      <button
        type="button"
        className={styles['call-row']}
        aria-label={t('agent.call.open', { name: title })}
        aria-pressed={isSelected}
        onClick={() => onSelect(trace.id)}
      >
        <span className={styles['call-mark']} data-tone={tone} aria-hidden="true">
          {isRunning ? <LoadingOutlined /> : needsAttention ? <WarningOutlined /> : null}
        </span>
        <span className={styles['call-title']}>{title}</span>
        {title !== trace.name && <code className={styles['call-name']}>{trace.name}</code>}
        {summary && <span className={styles['call-args']} title={summary}>{summary}</span>}
        <span className={styles['call-spacer']} />
        <span className={styles['call-status']} data-tone={tone}>{t(callStatusKey(trace))}</span>
        {(isRunning || duration !== undefined) && <span className={styles['call-duration']}>
          {isRunning ? <LiveElapsed startedAtMS={trace.started_at_ms ?? Date.now()} isRunning /> : formatDuration(duration!)}
        </span>}
      </button>
      {trace.result.status === 'error' && trace.result.code && (
        <div className={styles['call-failure']}>
          <code>{trace.result.code}</code>
          {trace.result.detail && <span>{trace.result.detail}</span>}
        </div>
      )}
      {children}
    </div>
  );
});
