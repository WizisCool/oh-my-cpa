import type { Trace } from './types';

/**
 * What a call's row says about it, as plain facts: its tone, its arguments in brief and how long
 * it took. The conversation draws its rows from these and so does a saved copy of it, which is
 * what keeps the two from describing the same call differently.
 */

/** The tone a status earns in the console's semantic palette. */
export function statusTone(status: string, code?: string): 'success' | 'processing' | 'warning' | 'error' | 'default' {
  if (status === 'error' && code === 'cancelled') return 'default';
  switch (status) {
    case 'success':
      return 'success';
    case 'running':
    case 'executing':
      return 'processing';
    case 'pending':
    case 'partial':
    case 'uncertain':
    case 'expired':
      return 'warning';
    case 'error':
    case 'rejected':
      return 'error';
    default:
      return 'default';
  }
}

const ARGUMENT_SUMMARY_FIELDS = 3;
const ARGUMENT_SUMMARY_CHARS = 32;

/**
 * A call's arguments as one short line: the first few top-level fields as `name=value`, each value
 * clipped. The whole argument text is one click away in the details panel; the row only has to say
 * which window, which provider, which model.
 */
export function argumentSummary(argumentsText: string | undefined): string {
  if (!argumentsText) return '';
  let value: unknown;
  try {
    value = JSON.parse(argumentsText);
  } catch {
    return '';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '';
  const clip = (text: string) => (text.length > ARGUMENT_SUMMARY_CHARS ? `${text.slice(0, ARGUMENT_SUMMARY_CHARS)}…` : text);
  const fields = Object.entries(value)
    .filter(([, field]) => field !== null && field !== '' && !(Array.isArray(field) && field.length === 0))
    .map(([key, field]) => `${key}=${clip(typeof field === 'string' ? field : JSON.stringify(field))}`);
  const shown = fields.slice(0, ARGUMENT_SUMMARY_FIELDS).join(' · ');
  return fields.length > ARGUMENT_SUMMARY_FIELDS ? `${shown} · +${fields.length - ARGUMENT_SUMMARY_FIELDS}` : shown;
}

/** How long a call took, or how long it has been running when `nowMS` is given. */
export function callDuration(trace: Pick<Trace, 'started_at_ms' | 'ended_at_ms'>, nowMS?: number): number | undefined {
  if (!trace.started_at_ms) return undefined;
  const end = trace.ended_at_ms ?? nowMS;
  return end === undefined ? undefined : Math.max(0, end - trace.started_at_ms);
}
