import { isAuthFileDisabled, isAuthFileProblem } from '../../components/authFiles/authFileLogic';
import type { OAuthWorkspaceRecord } from './oauthWorkspaceLogic';

/**
 * The verdict a credential gets in the workspace's health band.
 *
 * Every credential lands in exactly one bucket, most demanding first, so the band's segments add up
 * to the fleet and a click on a segment shows exactly the credentials it counted.
 */
export type HealthBucket = 'attention' | 'stale' | 'healthy' | 'disabled';

/** The band's segments, in the order they are drawn: what needs a hand leads. */
export const HEALTH_BUCKETS: readonly HealthBucket[] = ['attention', 'stale', 'healthy', 'disabled'];

/** The health band's filter: every credential, or one bucket of it. */
export type HealthLens = 'all' | HealthBucket;

const HEALTH_LENSES = new Set<string>(['all', ...HEALTH_BUCKETS]);

export function parseHealthLens(raw: string | null | undefined): HealthLens {
  return raw && HEALTH_LENSES.has(raw) ? raw as HealthLens : 'all';
}

export function healthBucketOf(record: OAuthWorkspaceRecord): HealthBucket {
  if (record.file.runtime_only || isAuthFileDisabled(record.file)) return 'disabled';
  if (record.isQuotaAttention || isAuthFileProblem(record.file)) return 'attention';
  if (record.quotaCondition === 'stale') return 'stale';
  return 'healthy';
}

export function healthCounts(records: readonly OAuthWorkspaceRecord[]): Record<HealthBucket, number> {
  const counts: Record<HealthBucket, number> = { attention: 0, stale: 0, healthy: 0, disabled: 0 };
  for (const record of records) counts[healthBucketOf(record)] += 1;
  return counts;
}

export function matchesHealthLens(record: OAuthWorkspaceRecord, lens: HealthLens): boolean {
  return lens === 'all' || healthBucketOf(record) === lens;
}

/**
 * The credential's recent traffic as twelve hourly buckets, oldest first, and its lifetime success
 * share. Buckets CPA did not report are not invented: a credential without history has none.
 */
export interface ActivitySummary {
  buckets: number[];
  failures: number[];
  total: number;
  successRate?: number;
}

export function activityOf(record: OAuthWorkspaceRecord): ActivitySummary {
  const recent = record.file.recent_requests ?? [];
  const buckets = recent.map((bucket) => (bucket.success ?? 0) + (bucket.failed ?? 0));
  const failures = recent.map((bucket) => bucket.failed ?? 0);
  const success = record.file.success ?? 0;
  const failed = record.file.failed ?? 0;
  const total = success + failed;
  return { buckets, failures, total, successRate: total > 0 ? (success / total) * 100 : undefined };
}

/**
 * The providers the rail lists, each with its credential count and how many need a hand, in the
 * operator's arrangement. A provider with no credential is not listed: signing in is how one joins.
 */
export interface ProviderSummary {
  provider: string;
  total: number;
  attention: number;
  disabled: number;
}

export function providerSummaries(records: readonly OAuthWorkspaceRecord[], order: readonly string[]): ProviderSummary[] {
  const byProvider = new Map<string, ProviderSummary>();
  for (const record of records) {
    const provider = record.displayProvider;
    const summary = byProvider.get(provider) ?? { provider, total: 0, attention: 0, disabled: 0 };
    summary.total += 1;
    const bucket = healthBucketOf(record);
    if (bucket === 'attention') summary.attention += 1;
    if (bucket === 'disabled') summary.disabled += 1;
    byProvider.set(provider, summary);
  }
  return order.flatMap((provider) => {
    const summary = byProvider.get(provider);
    return summary ? [summary] : [];
  });
}
