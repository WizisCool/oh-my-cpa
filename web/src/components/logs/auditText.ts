import { hasMessage, type TFunc } from '../../i18n';

const MAINTENANCE_ACTION = /^system\.maintenance\.(.+?)(\.completed)?$/;

/**
 * The sentence an audit action reads as.
 *
 * Actions are stable identifiers, so most have a sentence of their own. Two families are
 * open-ended - one entry per Agent capability and one per maintenance job - and read as a
 * template around their name. Anything else prints its code: an identifier the console
 * has no sentence for is still the truth, and a guess would not be.
 */
export function auditActionLabel(action: string, t: TFunc): string {
  const key = `audit.action.${action}`;
  if (hasMessage(key)) return t(key);
  if (action.startsWith('capability.')) {
    return t('audit.action.capability', { name: action.slice('capability.'.length) });
  }
  const maintenance = action.match(MAINTENANCE_ACTION);
  if (maintenance) {
    return t(maintenance[2] ? 'audit.action.maintenance_completed' : 'audit.action.maintenance', { name: maintenance[1] });
  }
  return action;
}

export function auditResultLabel(result: string, t: TFunc): string {
  const key = `audit.result.${result}`;
  return hasMessage(key) ? t(key) : result;
}
