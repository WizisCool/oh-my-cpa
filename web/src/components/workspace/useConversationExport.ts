import React from 'react';
import { useI18n } from '../../i18n';
import { languageLocale } from '../../i18n/language';
import { capabilityTitle } from '../../i18n/capabilities';
import { useToast } from '../feedback';
import { getTimeZone } from '../../utils/time';
import { failureKey, formatDuration, isKnownTurnStatus } from '../../pages/agent/state';
import { playgroundErrorKey } from '../../pages/playground/errors';
import type { ConversationSnapshot } from '../../agent/conversationSnapshot';
import type { SnapshotLabels } from '../../agent/conversationHtml';

export function useConversationExport(kind: 'agent' | 'playground') {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [isExporting, setIsExporting] = React.useState(false);
  const isExportingRef = React.useRef(false);
  const exportSnapshot = async (snapshot: ConversationSnapshot, format: 'html' | 'image') => {
    if (isExportingRef.current) return;
    isExportingRef.current = true;
    setIsExporting(true);
    const exportedAt = new Date();
    const computedStyle = getComputedStyle(document.documentElement);
    const keys = ['bg', 'surface', 'hover', 'fg', 'fg-2', 'muted', 'meta', 'border', 'border-soft', 'accent', 'success', 'warn', 'danger', ...Array.from({ length: 6 }, (_, index) => `series-${index + 1}`)];
    const variables = Object.fromEntries(keys.map(key => [`--${key}`, computedStyle.getPropertyValue(`--${key}`).trim()]));
    const locale = languageLocale(lang);
    const numberFormat = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 2 });
    const labels: SnapshotLabels = {
      title: t(kind === 'agent' ? 'nav.agent' : 'nav.playground'),
      operator: t('agent.export.operator'), answer: t('agent.export.answer_heading'), model: t('agent.export.model'),
      exportedAt: t('agent.export.exported_at'), thought: t('conversation.thought_process'), parameters: t('pg.parameters'),
      arguments: t('agent.details.arguments'), result: t('agent.details.model_content'), data: t('agent.export.data'),
      copy: t('agent.export.copy'), copied: t('agent.export.copied'), copyFailed: t('agent.export.copy_failed'),
      search: t('agent.export.search'), expand: t('agent.export.expand'), collapse: t('agent.export.collapse'),
      panel: t('agent.panel'), close: t('common.close'), chart: t('agent.view.chart'), usage: t('agent.foot.tokens'),
      noMatches: t('agent.export.no_matches'),
      calls: count => t('agent.chain.used', { count }),
      turns: count => t('agent.export.turns', { count }),
      number: value => numberFormat.format(value),
      axisTime: milliseconds => new Intl.DateTimeFormat(locale, { timeZone: getTimeZone(), month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(milliseconds),
      tokens: count => `${t('pg.total_tokens')} ${new Intl.NumberFormat(locale).format(count)}`, print: t('agent.export.print'), imageOmitted: t('agent.export.image_omitted'), privacy: t('agent.export.privacy'),
      omitted: count => t('agent.export.omitted', { count }),
      status: status => t(kind === 'playground' ? `pg.status.${status}` : status === 'cancelled' ? 'agent.status.stopped' :
        status === 'running' ? 'agent.call.running' : isKnownTurnStatus(status) ? `agent.status.${status}` : 'agent.status.unknown'),
      capability: name => capabilityTitle(name, t),
      failure: code => t(kind === 'agent' ? failureKey(code) : playgroundErrorKey(code)),
      duration: formatDuration,
      date: milliseconds => new Intl.DateTimeFormat(locale, { timeZone: getTimeZone(), dateStyle: 'medium', timeStyle: 'short' }).format(milliseconds),
    };
    try {
      const { downloadConversation } = await import('../../agent/conversationDownload');
      await downloadConversation({ snapshot, labels, appearance: { variables }, exportedAt, language: lang }, format, `omc-${kind}`);
    } catch { toast.error(t('agent.export.failed')); }
    finally { isExportingRef.current = false; setIsExporting(false); }
  };
  return { isExporting, exportSnapshot };
}
