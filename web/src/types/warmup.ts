import { providerDisplayName } from './providerMetadata';

export const WARMUP_TASK_ORDER_PREFERENCE = 'omc_warmup_task_order';
export const WARMUP_BATCH_MAX_TASKS = 100;

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

export interface WarmupTaskGroup {
  provider: string;
  label: string;
  tasks: WarmupTask[];
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

/**
 * Groups warmup tasks by provider in catalogue order (followed by any provider missing from the
 * catalogue in first-seen task order).
 */
export function groupWarmupTasks(
  tasks: readonly WarmupTask[],
  catalog?: WarmupCatalog,
  pluginTitles?: ReadonlyMap<string, string>,
): WarmupTaskGroup[] {
  if (tasks.length === 0) return [];
  const buckets = new Map<string, WarmupTask[]>();
  for (const task of tasks) {
    const provider = task.provider.trim() || 'unknown';
    const existing = buckets.get(provider);
    if (existing) existing.push(task);
    else buckets.set(provider, [task]);
  }
  const orderedProviders: string[] = [];
  for (const group of catalog?.providers ?? []) {
    if (buckets.has(group.provider) && !orderedProviders.includes(group.provider)) {
      orderedProviders.push(group.provider);
    }
  }
  for (const provider of buckets.keys()) {
    if (!orderedProviders.includes(provider)) orderedProviders.push(provider);
  }
  return orderedProviders.map((provider) => ({
    provider,
    label: providerDisplayName(provider, pluginTitles),
    tasks: buckets.get(provider) ?? [],
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
  const trigger = triggerToken(task.trigger);
  return trigger === null ? target : `${target} (${trigger})`;
}

function triggerToken(trigger: WarmupTaskInput['trigger']): string | null {
  switch (trigger.kind) {
    case 'window':
      return trigger.window ?? '';
    case 'daily':
      return trigger.time ?? '';
    case 'every':
      return `${trigger.hours ?? 0}h`;
    default:
      return null;
  }
}

/** Names stored before the server wrote the trigger in parentheses still read as generated. */
function legacyGeneratedTaskName(task: Pick<WarmupTaskInput, 'account' | 'auth_index' | 'provider' | 'trigger'>): string {
  const target = task.account.trim() || task.auth_index.trim() || task.provider.trim();
  const trigger = triggerToken(task.trigger);
  return trigger === null ? target : `${target} \u00b7 ${trigger}`; // separator-ok: recognises names stored before
}

export function hasCustomTaskName(task: Pick<WarmupTaskInput, 'name' | 'account' | 'auth_index' | 'provider' | 'trigger'>): boolean {
  const name = task.name.trim();
  return name !== '' && name !== generatedTaskName(task) && name !== legacyGeneratedTaskName(task);
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

function defaultWindowsForProvider(provider: string): string[] {
  return ['five_hour', provider === 'codex' ? 'weekly' : 'seven_day'];
}

function accountWindowIds(account: WarmupCatalogAccount): string[] {
  return account.windows.length > 0
    ? account.windows.map((w) => w.id)
    : defaultWindowsForProvider(account.provider);
}

/**
 * Normalizes synonymous 7-day window IDs (`weekly` on Codex, `seven_day` on Claude and others)
 * so cross-provider batch selections can intersect them without losing the standard 7-day option.
 */
function canonicalWindowKey(id: string): string {
  return id === 'weekly' || id === 'seven_day' ? 'seven_day' : id;
}

/**
 * Returns selectable window IDs for one or more credentials. A single credential shows every
 * window it reports; multiple credentials intersect their windows with `weekly`/`seven_day`
 * unified as one 7-day choice (falling back to standard windows when snapshots are absent).
 */
export function commonWarmupWindows(
  accounts: readonly WarmupCatalogAccount[],
  fallbackProvider = 'codex',
): string[] {
  if (accounts.length === 0) return defaultWindowsForProvider(fallbackProvider);
  if (accounts.length === 1) return accountWindowIds(accounts[0]);

  const first = accountWindowIds(accounts[0]);
  const commonKeys = new Set(first.map(canonicalWindowKey));
  for (let i = 1; i < accounts.length; i += 1) {
    const nextKeys = new Set(accountWindowIds(accounts[i]).map(canonicalWindowKey));
    for (const key of Array.from(commonKeys)) {
      if (!nextKeys.has(key)) commonKeys.delete(key);
    }
  }

  const singleProvider = accounts.every((acc) => acc.provider === accounts[0].provider);
  const ordered: string[] = [];
  const emitted = new Set<string>();
  for (const id of first) {
    const key = canonicalWindowKey(id);
    if (!commonKeys.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    if (key === 'seven_day') {
      ordered.push(singleProvider && accounts[0].provider === 'codex' ? 'weekly' : 'seven_day');
    } else {
      ordered.push(id);
    }
  }
  return ordered.length > 0 ? ordered : ['five_hour', 'seven_day'];
}

/**
 * Resolves a shared window selection onto a specific credential, mapping `weekly`/`seven_day`
 * back to whichever spelling that credential's snapshot or provider expects.
 */
export function resolveAccountWindow(windowId: string, account: WarmupCatalogAccount): string {
  const key = canonicalWindowKey(windowId);
  const matched = account.windows.find((w) => w.id === windowId || canonicalWindowKey(w.id) === key);
  if (matched) return matched.id;
  if (key === 'seven_day') return account.provider === 'codex' ? 'weekly' : 'seven_day';
  return windowId;
}

/**
 * Models supported by every selected credential. Cross-provider selections usually yield an
 * empty list so the caller stays on Auto and lets each credential pick its own lightest model.
 */
export function commonWarmupModels(accounts: readonly WarmupCatalogAccount[]): string[] {
  if (accounts.length === 0) return [];
  if (accounts.length === 1) return accounts[0].models;
  const sets = accounts.slice(1).map((acc) => new Set(acc.models));
  return accounts[0].models.filter((model) => sets.every((set) => set.has(model)));
}

export function canSaveWarmupBatch(
  draft: WarmupTaskInput,
  selectedAccounts: readonly WarmupCatalogAccount[],
): boolean {
  if (selectedAccounts.length === 0 || selectedAccounts.length > WARMUP_BATCH_MAX_TASKS) return false;
  return selectedAccounts.every((account) => canSaveWarmupTask({
    ...draft,
    provider: account.provider,
    auth_index: account.auth_index,
    account: account.name,
    trigger: draft.trigger.kind === 'window'
      ? { ...draft.trigger, window: resolveAccountWindow(draft.trigger.window ?? '', account) }
      : draft.trigger,
  }));
}

/**
 * Expands a batch draft across selected credentials. When a custom name is provided for multiple
 * credentials, it prefixes each credential's label (`{name} ({account})`) so tasks stay distinct.
 */
export function buildWarmupBatchPayloads(
  basePayload: WarmupTaskInput,
  selectedAccounts: readonly WarmupCatalogAccount[],
): WarmupTaskInput[] {
  const trimmedName = basePayload.name.trim();
  const isMulti = selectedAccounts.length > 1;
  return selectedAccounts.map((account) => {
    const label = account.email || account.name || account.auth_index;
    const name = !trimmedName ? '' : isMulti ? `${trimmedName} (${label})` : trimmedName;
    const trigger: WarmupTrigger = basePayload.trigger.kind === 'window'
      ? { kind: 'window', window: resolveAccountWindow(basePayload.trigger.window ?? 'five_hour', account) }
      : basePayload.trigger;
    return {
      name,
      enabled: basePayload.enabled,
      provider: account.provider,
      auth_index: account.auth_index,
      account: account.name,
      model: basePayload.model,
      trigger,
    };
  });
}
