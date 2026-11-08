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

const LIGHT_TIERS: Array<{ pattern: RegExp; rank: number }> = [
  { pattern: /(?:^|[^a-z0-9])flash(?:[^a-z0-9]|$)/i, rank: 0 },
  { pattern: /(?:^|[^a-z0-9])lite(?:[^a-z0-9]|$)/i, rank: 1 },
  { pattern: /(?:^|[^a-z0-9])mini(?:[^a-z0-9]|$)/i, rank: 2 },
  { pattern: /(?:^|[^a-z0-9])nano(?:[^a-z0-9]|$)/i, rank: 3 },
  { pattern: /(?:^|[^a-z0-9])small(?:[^a-z0-9]|$)/i, rank: 4 },
  { pattern: /(?:^|[^a-z0-9])turbo(?:[^a-z0-9]|$)/i, rank: 5 },
  { pattern: /(?:^|[^a-z0-9])haiku(?:[^a-z0-9]|$)/i, rank: 6 },
];

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function lightTierRank(model: string): number {
  for (const tier of LIGHT_TIERS) {
    if (tier.pattern.test(model)) return tier.rank;
  }
  return LIGHT_TIERS.length;
}

export function sortModelsForAuto(models: string[]): string[] {
  return [...models].sort((a, b) => {
    const rankDiff = lightTierRank(a) - lightTierRank(b);
    if (rankDiff !== 0) return rankDiff;
    return COLLATOR.compare(b, a);
  });
}

export function pickAutoModel(models: string[]): string {
  const clean = models.map((m) => m.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  return sortModelsForAuto(clean)[0] ?? '';
}

export function resolveTaskModel(
  task: Pick<WarmupTaskInput, 'model'>,
  account?: WarmupCatalogAccount,
): string {
  const explicit = task.model.trim();
  if (explicit) return explicit;
  if (!account) return '';
  return account.auto_model || pickAutoModel(account.models);
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

export function defaultWarmupTaskInput(
  account?: WarmupCatalogAccount,
  timezone = 'UTC',
): WarmupTaskInput {
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
      time_zone: timezone || 'UTC',
      hours: 5,
      anchor: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  };
}
