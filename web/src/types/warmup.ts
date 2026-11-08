import { providerDisplayName } from './providerMetadata';

export interface WarmupTrigger {
  kind: 'window' | 'daily' | 'every';
  window?: string;
  time?: string;
  time_zone?: string;
  hours?: number;
  anchor?: string;
}

export interface WarmupTask {
  id: string;
  name: string;
  enabled: boolean;
  provider: string;
  auth_index: string;
  account: string;
  model: string;
  trigger: WarmupTrigger;
  created_at: string;
  updated_at: string;
}

export interface WarmupTaskInput {
  name: string;
  enabled: boolean;
  provider: string;
  auth_index: string;
  account: string;
  model: string;
  trigger: WarmupTrigger;
}

export interface WarmupRun {
  id: string;
  task_id: string;
  task_name: string;
  at: string;
  outcome: 'ok' | 'failed' | 'unknown' | 'running';
  source: 'schedule' | 'catchup' | 'manual';
  provider: string;
  auth_index: string;
  account: string;
  model: string;
  ms?: number;
  message?: string;
  due?: string;
  reset_key?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export interface WarmupQuotaWindow {
  id: string;
  label: string;
  used_percent: number | null;
  resets_at?: string;
}

export interface WarmupCatalogAccount {
  auth_index: string;
  name: string;
  provider: string;
  /** The login portal that issued the credential, when a plugin declares several. */
  oauth_provider?: string;
  email?: string;
  status?: string;
  disabled?: boolean;
  models: string[];
  auto_model: string;
  windows: WarmupQuotaWindow[];
  snapshot_at?: string;
}

export interface WarmupCatalogProvider {
  provider: string;
  accounts: WarmupCatalogAccount[];
}

export interface WarmupCatalog {
  providers: WarmupCatalogProvider[];
  timezone: string;
}

export interface WarmupTimelineEntry {
  task_id: string;
  task_name: string;
  at: string;
  account: string;
  model: string;
}

export interface WarmupStateView {
  tasks: WarmupTask[];
  runs: WarmupRun[];
  next: Record<string, string | null>;
  timeline: WarmupTimelineEntry[];
  catalog?: WarmupCatalog;
}

export interface WarmupRunResponse {
  run: WarmupRun;
  state: WarmupStateView;
}

export interface WarmupCredentialGroup {
  provider: string;
  label: string;
  accounts: WarmupCatalogAccount[];
}

/**
 * The credential picker's groups: one per provider, in the catalogue's own order and named the way
 * the rest of the console names that provider.
 */
export function groupWarmupAccounts(
  catalog?: WarmupCatalog,
  pluginTitles?: ReadonlyMap<string, string>,
): WarmupCredentialGroup[] {
  return (catalog?.providers ?? [])
    .filter((group) => group.accounts.length > 0)
    .map((group) => ({
      provider: group.provider,
      label: providerDisplayName(group.provider, pluginTitles),
      accounts: group.accounts,
    }));
}

/** The task's own model, else the one the server picked for Auto: the server alone knows which listed names are OAuth aliases. */
export function resolveTaskModel(
  task: Pick<WarmupTaskInput, 'model'>,
  account?: WarmupCatalogAccount,
): string {
  const explicit = task.model.trim();
  if (explicit) return explicit;
  if (!account) return '';
  return account.auto_model;
}

export function canSaveWarmupTask(task: WarmupTaskInput): boolean {
  if (!task.provider.trim()) return false;
  if (!task.auth_index.trim() && !task.account.trim()) return false;
  const { trigger } = task;
  switch (trigger.kind) {
    case 'window':
      return Boolean(trigger.window?.trim());
    case 'daily':
      return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trigger.time ?? '');
    case 'every':
      return (
        typeof trigger.hours === 'number'
        && Number.isInteger(trigger.hours)
        && trigger.hours >= 1
        && trigger.hours <= 168
        && Boolean(trigger.anchor && !Number.isNaN(Date.parse(trigger.anchor)))
      );
    default:
      return false;
  }
}

/**
 * The name the server stores when a task is saved without one (Go `warmup.DefaultTaskName`). It
 * is frozen at save time, so a task carrying it is shown and edited as unnamed: otherwise a later
 * change of credential or trigger would keep the old credential's name.
 */
export function generatedTaskName(task: Pick<WarmupTaskInput, 'account' | 'auth_index' | 'provider' | 'trigger'>): string {
  const target = task.account.trim() || task.auth_index.trim() || task.provider.trim();
  switch (task.trigger.kind) {
    case 'window':
      return `${target} · ${task.trigger.window ?? ''}`;
    case 'daily':
      return `${target} · ${task.trigger.time ?? ''}`;
    case 'every':
      return `${target} · ${task.trigger.hours ?? 0}h`;
    default:
      return target;
  }
}

export function hasCustomTaskName(task: Pick<WarmupTaskInput, 'name' | 'account' | 'auth_index' | 'provider' | 'trigger'>): boolean {
  const name = task.name.trim();
  return name !== '' && name !== generatedTaskName(task);
}

/** A new task's draft, on the first credential the picker lets the operator choose. */
export function defaultWarmupTaskInput(catalog?: WarmupCatalog): WarmupTaskInput {
  const account = catalog?.providers.flatMap((group) => group.accounts).find((acc) => !acc.disabled);
  const provider = account?.provider ?? 'codex';
  const defaultWindow = account?.windows[0]?.id ?? 'five_hour';
  return {
    name: '',
    enabled: true,
    provider,
    auth_index: account?.auth_index ?? '',
    account: account?.name ?? '',
    model: '',
    trigger: {
      kind: 'window',
      window: defaultWindow,
      time: '08:55',
      time_zone: catalog?.timezone || 'UTC',
      hours: 5,
      anchor: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  };
}
