import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useT } from '../i18n';
import { PageHeader } from '../components/common/PageHeader';
import { AuditTrail } from '../components/audit/AuditTrail';
import { readAuditFilters, writeAuditFilters, type AuditFilters } from '../types/audit';

/**
 * The operator audit trail: the durable record of what was done through this console.
 *
 * It is a page of its own rather than a source of the logs page because it answers a
 * different question - who changed what, and did it land - over a much longer span than a
 * log tail, and it is read by filtering and counting rather than by following. The filters
 * live in the URL, so a link can open the trail already narrowed to one target or request.
 */
export const AuditPage: React.FC = () => {
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = React.useMemo(() => readAuditFilters(searchParams), [searchParams]);
  const setFilters = React.useCallback(
    (next: AuditFilters) => setSearchParams(writeAuditFilters(next), { replace: true }),
    [setSearchParams],
  );

  return (
    <div className="terminal-page" data-testid="audit-page">
      <PageHeader title={t('nav.audit')} subtitle={t('audit.subtitle')} />
      <AuditTrail filters={filters} onFiltersChange={setFilters} />
    </div>
  );
};
