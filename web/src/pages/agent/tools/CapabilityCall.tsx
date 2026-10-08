import React from 'react';
import { clsx } from 'clsx';
import { CheckOutlined, CloseOutlined, LoadingOutlined, RightOutlined, WarningOutlined } from '../../../components/icons';
import { CodeBlock } from '../../../components/workspace/ModelMarkdown';
import workspace from '../../../components/workspace/Workspace.module.css';
import { useI18n } from '../../../i18n';
import { capabilityTitle } from '../../../i18n/capabilities';
import type { Trace } from '../../../agent/types';
import { toBrowserTime } from '../../../types/serverClock';
import { argumentSummary, callDuration, callStatusKey, formatClock, formatDuration, statusTone } from '../state';
import { LiveElapsed } from '../../../components/workspace/LiveElapsed';
import styles from '../AgentPage.module.css';

export interface CapabilityCallProps {
  trace: Trace;
  /** Drawn under the row: an approval card. */
  children?: React.ReactNode;
}

function prettyJSON(text: string | undefined): string {
  if (!text) return '{}';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * One capability call as a disclosure (ADR 0084): a row an operator scans, and under it, on
 * request, what was sent and what came back.
 *
 * The row is a status mark, the call's title in the operator's language, its arguments in brief
 * and how long it took. It appears the moment the call starts, before it has a result, so a slow
 * capability reads as running rather than as nothing happening. Opening it shows the request and
 * the receipt in place, so the answer the call belongs to stays beside what is being read.
 *
 * The receipt is the exact JSON the model was given. A database query has none here: its rows stay
 * on the server, and the model is handed a reference to them.
 */
export const CapabilityCall = React.memo(function CapabilityCall({ trace, children }: CapabilityCallProps) {
  const { t, lang } = useI18n();
  const [isOpen, setIsOpen] = React.useState(false);
  // The panel's content is built on first opening and kept, so it is there to fold away.
  const [hasOpened, setHasOpened] = React.useState(false);
  const panelID = React.useId();
  const isRunning = trace.result.status === 'running';
  const tone = statusTone(trace.result.status, trace.result.code);
  const duration = callDuration(trace);
  const summary = argumentSummary(trace.arguments);
  const title = capabilityTitle(trace.name, t);
  const isSettledWell = trace.result.status === 'success';
  const received = trace.name === 'database_query' || isRunning || trace.result.status === 'pending'
    ? undefined
    : JSON.stringify(trace.result, null, 2);
  return (
    <div className={styles['call']} data-testid="agent-trace" data-status={trace.result.status} data-open={isOpen || undefined}>
      <button
        type="button"
        className={styles['call-row']}
        aria-label={t('agent.call.open', { name: title })}
        aria-expanded={isOpen}
        aria-controls={panelID}
        onClick={() => { setHasOpened(true); setIsOpen(value => !value); }}
      >
        <span className={styles['call-mark']} data-step-mark data-tone={tone} aria-hidden="true">
          {isRunning ? <LoadingOutlined /> : tone === 'warning' ? <WarningOutlined /> : tone === 'success' ? <CheckOutlined /> : tone === 'error' ? <CloseOutlined /> : null}
        </span>
        <span className={clsx(styles['call-title'], isRunning && workspace['live-text'])}>{title}</span>
        {summary && <span className={styles['call-args']} title={summary}>{summary}</span>}
        <span className={styles['call-spacer']} />
        {!isSettledWell && !isRunning && <span className={styles['call-status']} data-tone={tone}>{t(callStatusKey(trace))}</span>}
        {(isRunning || duration !== undefined) && <span className={styles['call-duration']}>
          {isRunning ? <LiveElapsed startedAtMS={trace.started_at_ms ? toBrowserTime(trace.started_at_ms) : Date.now()} isRunning /> : formatDuration(duration!)}
        </span>}
        <RightOutlined className={styles['call-caret']} aria-hidden="true" />
      </button>
      {trace.result.status === 'error' && trace.result.code && (
        <div className={styles['call-failure']}>
          <code>{trace.result.code}</code>
          {trace.result.detail && <span>{trace.result.detail}</span>}
        </div>
      )}
      <div id={panelID} className={styles['fold']} data-open={isOpen || undefined} data-testid="agent-call-panel" role="region" aria-label={title}>
        <div className={styles['fold-inner']}>
          {hasOpened && (
            <div className={styles['call-detail']}>
              <div className={styles['call-facts']}>
                <code className={styles['call-name']}>{trace.name}</code>
                <span className={workspace['status']}>
                  <span className={workspace['pip']} data-tone={tone} aria-hidden="true" />
                  {t(callStatusKey(trace))}
                </span>
                {!!trace.started_at_ms && <span>{formatClock(trace.started_at_ms, lang)}</span>}
              </div>
              <section className={styles['call-section']}>
                <h4 className={workspace['section-title']}>{t('agent.details.arguments')}</h4>
                <CodeBlock lang="json" block>{prettyJSON(trace.arguments)}</CodeBlock>
              </section>
              {received && (
                <section className={styles['call-section']}>
                  <h4 className={workspace['section-title']}>{t('agent.details.model_content')}</h4>
                  <CodeBlock lang="json" block>{received}</CodeBlock>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
});
