import { buildOAuthWorkspaceProjection, type OAuthWorkspaceRecord } from '../../web/src/pages/oauthManagement/oauthWorkspaceLogic';
import type { AuthFileSortKey } from '../../web/src/components/authFiles/authFileLogic';

export const OAUTH_SORT_KEYS: AuthFileSortKey[] = ['name-asc', 'name-desc', 'requests-desc', 'priority-desc', 'weight-desc'];

export function createOAuthSortRecords(count: number): OAuthWorkspaceRecord[] {
  const files = Array.from({length: count}, (_, index) => {
    const number = (index * 7919) % Math.max(1, count);
    return {name: `credential-${number}.json`, auth_index: `auth-${index}`, provider: 'codex', disabled: false,
      unavailable: false, runtime_only: false, success: index % 7, failed: index % 3,
      priority: index % 4 === 0 ? undefined : index % 4, weight: index % 3 === 0 ? undefined : index % 3};
  });
  return buildOAuthWorkspaceProjection(files, [], []).records;
}

// Frozen baseline algorithm: the oracle deliberately does not share the optimized comparator.
export function legacyOAuthSort(records: OAuthWorkspaceRecord[], sort: AuthFileSortKey): OAuthWorkspaceRecord[] {
  const copy = [...records];
  const byName = (left: OAuthWorkspaceRecord, right: OAuthWorkspaceRecord) =>
    left.file.name.localeCompare(right.file.name, undefined, {numeric: true, sensitivity: 'base'});
  switch (sort) {
    case 'name-desc': return copy.sort((left, right) => byName(right, left));
    case 'requests-desc': return copy.sort((left, right) => (right.file.success + right.file.failed) - (left.file.success + left.file.failed) || byName(left, right));
    case 'priority-desc': return copy.sort((left, right) => (right.file.priority ?? 0) - (left.file.priority ?? 0) || byName(left, right));
    case 'weight-desc': return copy.sort((left, right) => (right.file.weight ?? 1) - (left.file.weight ?? 1) || byName(left, right));
    case 'name-asc':
    default: return copy.sort(byName);
  }
}
