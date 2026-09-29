import { Empty } from 'antd';
import { DisplayFigure } from './tools/DisplayCall';
import { CodeBlock } from '../../components/workspace/ModelMarkdown';
import workspace from '../../components/workspace/Workspace.module.css';
import type { Trace } from '../../agent/types';
import { useI18n } from '../../i18n';
import { capabilityTitle } from '../../i18n/capabilities';
import { callDuration, callStatusKey, formatClock, formatDuration, statusTone } from './state';
import styles from './AgentPage.module.css';

function prettyJSON(text: string | undefined): string {
  if (!text) return '{}';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * One call, in full: what the model asked for, what the model was told, and what it ran against.
 *
 * The transcript keeps a call to one row; the arguments and the result live here so an operator can
 * audit a call without the answer being buried under JSON. "What the model received" is shown
 * separately from the data because they differ for display calls: the model gets a small receipt,
 * while the rows it drew are frozen on the call.
 */
export function CallDetails({ trace }: { trace: Trace | undefined }) {
  const { t, lang } = useI18n();
  if (!trace) {
    return (
      <div className={styles['details-empty']} data-testid="agent-details">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('agent.details.empty')} />
      </div>
    );
  }
  const duration = callDuration(trace);
  const received = trace.result.status === 'running' || trace.result.status === 'pending'
    ? undefined
    : JSON.stringify(trace.result, null, 2);
  return (
    <div className={styles['details']} data-testid="agent-details">
      <header className={styles['details-head']}>
        <span className={styles['details-title']}>{capabilityTitle(trace.name, t)}</span>
        <code className={styles['call-name']}>{trace.name}</code>
      </header>
      <dl className={styles['operation-fields']}>
        <div className={styles['operation-field-row']}>
          <dt>{t('agent.details.status')}</dt>
          <dd>
            <span className={workspace['status']}>
              <span className={workspace['pip']} data-tone={statusTone(trace.result.status, trace.result.code)} aria-hidden="true" />
              {t(callStatusKey(trace))}
            </span>
          </dd>
        </div>
        {trace.started_at_ms && (
          <div className={styles['operation-field-row']}>
            <dt>{t('agent.details.started')}</dt>
            <dd>{formatClock(trace.started_at_ms, lang)}</dd>
          </div>
        )}
        {duration !== undefined && (
          <div className={styles['operation-field-row']}>
            <dt>{t('agent.details.duration')}</dt>
            <dd>{formatDuration(duration)}</dd>
          </div>
        )}
        {trace.result.code && (
          <div className={styles['operation-field-row']}>
            <dt>{t('agent.details.code')}</dt>
            <dd><code>{trace.result.code}</code></dd>
          </div>
        )}
      </dl>
      <section className={styles['details-section']}>
        <h3 className={workspace['section-title']}>{t('agent.details.arguments')}</h3>
        <CodeBlock lang="json" block>{prettyJSON(trace.arguments)}</CodeBlock>
      </section>
      {received && (
        <section className={styles['details-section']}>
          <h3 className={workspace['section-title']}>{t('agent.details.model_content')}</h3>
          <CodeBlock lang="json" block>{received}</CodeBlock>
        </section>
      )}
      {trace.view && (
        <section className={styles['details-section']}>
          <h3 className={workspace['section-title']}>{t('agent.details.view')}</h3>
          <p className={styles['details-note']}>
            {t('agent.details.view_note', { rows: String(trace.view.rows.length), source: trace.view.source?.call_id ?? t('agent.details.inline') })}
          </p>
          <DisplayFigure view={trace.view} />
        </section>
      )}
    </div>
  );
}
