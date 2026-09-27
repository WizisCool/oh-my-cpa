import React from 'react';
import { Alert, Button, Tabs } from 'antd';
import { HistoryOutlined } from '../../components/icons';
import { CopyButton } from '../../components/common/CopyButton';
import { CodeBlock } from '../../components/workspace/ModelMarkdown';
import workspace from '../../components/workspace/Workspace.module.css';
import { useI18n } from '../../i18n';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { buildCurl, effectiveModel, inspectRequest, turnTone } from './state';
import type { Turn } from './state';
import { playgroundErrorKey } from './errors';
import styles from './PlaygroundPage.module.css';

export interface InspectPanelProps {
  turn: Turn | undefined;
  defaultUserAgent: string;
  onOpenRequests: (turn: Turn) => void;
}

/**
 * The selected turn, as the gateway saw it: the measurements, the request snapshot and the bounded
 * response events.
 *
 * The documents are serialised once per turn rather than on every render, and the tab that is not
 * showing is not mounted - a response log can hold five hundred events, and highlighting it under
 * the parameters tab would be work nobody reads.
 */
export const InspectPanel = React.memo(function InspectPanel({ turn, defaultUserAgent, onOpenRequests }: InspectPanelProps) {
  const { t } = useI18n();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const requestJSON = React.useMemo(() => (turn ? JSON.stringify(inspectRequest(turn.request), null, 2) : ''), [turn?.request]);
  const curl = React.useMemo(() => (turn ? buildCurl(turn.request, defaultUserAgent) : ''), [turn?.request, defaultUserAgent]);
  const eventsJSON = React.useMemo(() => (turn ? JSON.stringify(turn.events, null, 2) : ''), [turn?.events]);

  if (!turn) {
    return (
      <div className={workspace['panel']}>
        <section className={workspace['panel-section']}>
          <p className={workspace['field-hint']}>{t('pg.no_turn')}</p>
        </section>
      </div>
    );
  }

  const unavailable = t('pg.unavailable');
  const milliseconds = (value?: number) => (value === undefined ? unavailable : `${Math.max(0, value).toLocaleString()} ms`);
  const tokens = (value?: number) => (value === undefined ? unavailable : formatTokens(value, tokenStyle));
  const metrics: [string, string][] = [
    [t('pg.first_content'), milliseconds(turn.firstContentMS)],
    [t('pg.duration'), milliseconds(turn.durationMS)],
    [t('pg.input_tokens'), tokens(turn.usage?.prompt_tokens)],
    [t('pg.output_tokens'), tokens(turn.usage?.completion_tokens)],
    [t('pg.total_tokens'), tokens(turn.usage?.total_tokens)],
    [t('pg.finish_reason'), turn.finishReason ?? unavailable],
  ];

  return (
    <div className={workspace['panel']}>
      <section className={workspace['panel-section']}>
        <div className={styles['inspect-head']}>
          <div className={styles['inspect-target']}>
            <span className={styles['inspect-model']}>{effectiveModel(turn.request)}</span>
            <span className={styles['inspect-key']}>{turn.keyLabel}</span>
          </div>
          <span className={workspace['status']}>
            <span className={workspace['pip']} data-tone={turnTone(turn.status)} aria-hidden="true" />
            {t(`pg.status.${turn.status}`)}
          </span>
        </div>
        <dl className={styles['metrics']}>
          {metrics.map(([label, value]) => (
            <div key={label} className={styles['metric-cell']}>
              <dt>{label}</dt>
              <dd data-unavailable={value === unavailable || undefined}>{value}</dd>
            </div>
          ))}
        </dl>
        {turn.error && (
          <Alert
            type="error"
            title={t(playgroundErrorKey(turn.error.code ?? ''))}
            description={<code>{[turn.error.code, turn.error.upstream_status, turn.error.parameter].filter(Boolean).join(' · ')}</code>}
          />
        )}
        <div className={styles['related']}>
          <Button icon={<HistoryOutlined />} onClick={() => onOpenRequests(turn)}>{t('pg.view_requests')}</Button>
          {/* The link filters by key, model and time; it is a candidate list, not the record. */}
          <p className={workspace['field-hint']}>{t('pg.usage_delay')}</p>
        </div>
      </section>
      <Tabs
        className={styles['inspect-tabs']}
        size="small"
        destroyOnHidden
        items={[
          {
            key: 'request',
            label: t('pg.request'),
            children: (
              <div className={styles['document']}>
                {/* The JSON block carries its own copy action; the cURL command is a different
                    document, so it is named in words rather than as a second identical glyph. */}
                <div className={styles['document-actions']}>
                  <CopyButton text={curl} label={t('pg.copy_curl')} showLabel />
                </div>
                {turn.hasOmittedHistory && <Alert type="info" title={t('pg.history_omitted')} />}
                <CodeBlock lang="json" block>{requestJSON}</CodeBlock>
              </div>
            ),
          },
          {
            key: 'response',
            label: t('pg.response'),
            children: (
              <div className={styles['document']}>
                {turn.isTruncated && <Alert type="warning" title={t('pg.truncated')} />}
                <CodeBlock lang="json" block>{eventsJSON}</CodeBlock>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
});

