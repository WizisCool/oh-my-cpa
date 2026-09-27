import React from 'react';
import { Segmented } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { useT } from '../i18n';
import { PageHeader } from '../components/common/PageHeader';
import { CpaLogPanel } from '../components/logs/CpaLogPanel';
import { ServiceLogPanel } from '../components/logs/ServiceLogPanel';
import { AuditTrail } from '../components/logs/AuditTrail';

const LOG_SOURCES = ['cpa', 'service', 'audit'] as const;
type LogSource = (typeof LOG_SOURCES)[number];

function parseSource(value: string | null): LogSource {
  return LOG_SOURCES.includes(value as LogSource) ? (value as LogSource) : 'cpa';
}

/**
 * The logs page reads three different records, and keeps them apart:
 *
 * - CPA gateway: the gateway's own log file and its request error files.
 * - OMC service: this console's backend log, from the bounded copy it keeps in memory.
 * - Audit trail: the durable record of what operators did through this console.
 *
 * Only one source is mounted at a time, so a source the operator is not looking at does not
 * poll. The choice lives in the URL, so a link can point at the audit trail directly.
 */
export const LogsPage: React.FC = () => {
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const source = parseSource(searchParams.get('source'));

  const selectSource = (next: LogSource) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === 'cpa') params.delete('source');
      else params.set('source', next);
      return params;
    }, { replace: true });
  };

  return (
    <div className="terminal-page logs-page">
      <PageHeader
        title={t('nav.logs')}
        actions={(
          <Segmented
            className="logs-source"
            value={source}
            options={[
              { value: 'cpa', label: t('logs.source_cpa') },
              { value: 'service', label: t('logs.source_service') },
              { value: 'audit', label: t('logs.source_audit') },
            ]}
            onChange={(value) => selectSource(value as LogSource)}
          />
        )}
      />
      {source === 'cpa' && <CpaLogPanel />}
      {source === 'service' && <ServiceLogPanel />}
      {source === 'audit' && <AuditTrail />}
    </div>
  );
};
