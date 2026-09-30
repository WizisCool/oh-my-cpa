import React from 'react';
import type { ExportLabels } from '../../agent/export';
import { useI18n } from '../../i18n';
import { capabilityTitle } from '../../i18n/capabilities';
import { failureKey, formatDuration, isKnownTurnStatus } from './state';

/** The export's words in the console's language, so a report reads like the page it came from. */
export function useExportLabels(): ExportLabels {
  const { t } = useI18n();
  return React.useMemo(() => ({
    title: t('agent.export.title'),
    model: t('agent.export.model'),
    exportedAt: t('agent.export.exported_at'),
    operator: t('agent.export.operator'),
    answer: t('agent.export.answer_heading'),
    calls: t('agent.export.calls'),
    status: (status: string) => t(status === 'running' ? 'agent.call.running' : isKnownTurnStatus(status) ? `agent.status.${status}` : 'agent.status.unknown'),
    capability: (name: string) => {
      const title = capabilityTitle(name, t);
      return title === name ? '' : title;
    },
    duration: formatDuration,
    failure: (code: string) => t(failureKey(code)),
  }), [t]);
}
