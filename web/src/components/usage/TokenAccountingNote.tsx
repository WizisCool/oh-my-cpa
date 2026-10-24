import { useT } from '../../i18n';
import { formatTokensFull } from '../../types/tokenDisplay';
import type { TokenAccounting } from '../../types/tokenAccounting';

export function tokenAccountingMessage(t: ReturnType<typeof useT>, accounting?: TokenAccounting | null): string {
  if (!accounting) return t('events.accounting_legacy');
  if (accounting.status !== 'complete') {
    return t('events.accounting_unresolved', {
      status: t(`events.accounting_status_${accounting.status}`),
      raw_input: formatTokensFull(accounting.raw_tokens.input_tokens),
      raw_output: formatTokensFull(accounting.raw_tokens.output_tokens),
    });
  }
  return t('events.accounting_complete', {
    version: accounting.version,
    raw_input: formatTokensFull(accounting.raw_tokens.input_tokens),
    raw_output: formatTokensFull(accounting.raw_tokens.output_tokens),
    input: formatTokensFull(accounting.token_breakdown.input.total_tokens),
    output: formatTokensFull(accounting.token_breakdown.output.total_tokens),
  });
}

export function TokenAccountingNote({ accounting, className }: { accounting?: TokenAccounting | null; className?: string }) {
  const t = useT();
  return <p className={className}>{tokenAccountingMessage(t, accounting)}</p>;
}
