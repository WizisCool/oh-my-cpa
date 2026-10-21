import type { ClientAPIKeyItem, ClientKeyUsageItem } from '../../types/providers';

/** The use tiles, in reading order; each one is also the list's filter. */
export const KEY_USE_FILTERS = ['all', 'active', 'idle'] as const;
export type KeyUseFilter = (typeof KEY_USE_FILTERS)[number];

/** One rendered row: a key from CPA's client-key list plus the identity and
 *  traffic Oh My CPA knows about it. A key has no state of its own to report —
 *  CPA accepts it by presence in that list (see ADR 0010). */
export interface ApiKeyRecord {
  id: string;
  /** Position in the client-key array; an edit writes back to this index. */
  index: number;
  key: string;
  usageFingerprint?: string;
  alias?: string;
  aliasVersion: number;
  usage?: ClientKeyUsageItem;
}

/**
 * Joins CPA's key list with the names and the window's traffic this console holds for each key.
 *
 * The join is by key text, so the metadata must come from the read that includes the keys; a
 * masked list would leave every name and every usage cell empty.
 */
export function buildKeyRecords(
  apiKeys: readonly string[],
  metadata: readonly ClientAPIKeyItem[] | undefined,
  usage: Readonly<Record<string, ClientKeyUsageItem>> | undefined,
): ApiKeyRecord[] {
  const metaByKey = new Map<string, ClientAPIKeyItem>();
  for (const item of metadata ?? []) metaByKey.set(item.key, item);
  return apiKeys.map((key, index) => {
    const entry = metaByKey.get(key);
    const usageFingerprint = entry?.usage_fingerprint;
    return {
      id: usageFingerprint ? `key-${usageFingerprint}` : `key-${index}`,
      index,
      key,
      usageFingerprint,
      alias: entry?.alias || undefined,
      aliasVersion: entry?.alias_version ?? 0,
      usage: usageFingerprint ? usage?.[usageFingerprint] : undefined,
    };
  });
}

function matchesUse(record: ApiKeyRecord, filter: KeyUseFilter): boolean {
  const requests = record.usage?.requests ?? 0;
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      return requests > 0;
    case 'idle':
      return requests === 0;
  }
}

function matchesSearch(record: ApiKeyRecord, query: string): boolean {
  return (record.alias ?? '').toLowerCase().includes(query) || record.key.toLowerCase().includes(query);
}

export interface KeyOverview {
  visible: ApiKeyRecord[];
  /** Per tile, over the searched list; `undefined` while the window's traffic is unknown. */
  counts: Record<KeyUseFilter, number> | undefined;
  /** The window's totals over every key, whatever the filters show. */
  window: { requests: number; failed: number; successRate: number | null } | undefined;
}

/**
 * The tiles' counts, the window's totals and the rows the filters leave.
 *
 * The counts follow the search but not the selected tile, so each tile says how many rows choosing
 * it would show. Until the window's traffic is known the use tiles cannot be answered: they are
 * withheld rather than shown as zero, and only the `all` filter narrows the list.
 */
export function summarizeKeys(
  records: readonly ApiKeyRecord[],
  filter: KeyUseFilter,
  search: string,
  isUsageKnown: boolean,
): KeyOverview {
  const query = search.trim().toLowerCase();
  const searched = query ? records.filter((record) => matchesSearch(record, query)) : [...records];
  const effective = isUsageKnown ? filter : 'all';
  const visible = searched.filter((record) => matchesUse(record, effective));
  if (!isUsageKnown) return { visible, counts: undefined, window: undefined };
  const counts = Object.fromEntries(
    KEY_USE_FILTERS.map((tile) => [tile, searched.filter((record) => matchesUse(record, tile)).length]),
  ) as Record<KeyUseFilter, number>;
  const requests = records.reduce((sum, record) => sum + (record.usage?.requests ?? 0), 0);
  const failed = records.reduce((sum, record) => sum + (record.usage?.failed ?? 0), 0);
  const successRate = requests > 0 ? ((requests - failed) / requests) * 100 : null;
  return { visible, counts, window: { requests, failed, successRate } };
}
