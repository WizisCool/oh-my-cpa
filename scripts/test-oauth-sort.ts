import assert from 'node:assert/strict';
import test from 'node:test';
import { sortOAuthWorkspaceRecords } from '../web/src/pages/oauthManagement/oauthWorkspaceLogic';
import type { AuthFileSortKey } from '../web/src/components/authFiles/authFileLogic';
import { createOAuthSortRecords, legacyOAuthSort, OAUTH_SORT_KEYS } from './fixtures/oauth-sort';

test('every OAuth sort preserves the baseline order, stable ties and input identity', () => {
  for (const count of [0, 1, 12, 120, 2300]) {
    const records = createOAuthSortRecords(count);
    const names = ['A2', 'a02', 'á2', 'a10', 'İ2', 'i2', 'é', 'e\u0301', '中2', '中10', '', '  '];
    if (count === 12) records.forEach((record, index) => { record.file.name = names[index]; });
    for (const record of records) { Object.freeze(record.file); Object.freeze(record); }
    Object.freeze(records);
    for (const sort of [...OAUTH_SORT_KEYS, 'unknown' as AuthFileSortKey]) {
      const actual = sortOAuthWorkspaceRecords(records, sort);
      assert.notEqual(actual, records);
      assert.deepEqual(actual, legacyOAuthSort(records, sort), `${count} records / ${sort}`);
      assert.ok(actual.every(record => records.includes(record)), 'retain record identities');
    }
  }
});

test('name ordering is numeric and base-sensitive with stable equivalent labels', () => {
  const records = createOAuthSortRecords(4);
  ['a10', 'A2', 'á2', 'a02'].forEach((name, index) => { records[index].file.name = name; });
  assert.deepEqual(sortOAuthWorkspaceRecords(records, 'name-asc').map(record => record.file.name), ['A2', 'á2', 'a02', 'a10']);
  assert.deepEqual(sortOAuthWorkspaceRecords(records, 'name-desc').map(record => record.file.name), ['a10', 'A2', 'á2', 'a02']);
});

test('numeric ranking keeps absent priority and weight defaults and name tiebreaks', () => {
  const records = createOAuthSortRecords(3);
  ['credential-10', 'credential-2', 'credential-1'].forEach((name, index) => { records[index].file.name = name; });
  records[0].file.priority = undefined; records[1].file.priority = 0; records[2].file.priority = 1;
  records[0].file.weight = undefined; records[1].file.weight = 1; records[2].file.weight = 0;
  records[0].file.success = 1; records[0].file.failed = 1;
  records[1].file.success = 2; records[1].file.failed = 0;
  records[2].file.success = 0; records[2].file.failed = 0;
  const indexes = (sort: AuthFileSortKey) => sortOAuthWorkspaceRecords(records, sort).map(record => records.indexOf(record));
  assert.deepEqual(indexes('priority-desc'), [2, 1, 0]);
  assert.deepEqual(indexes('weight-desc'), [1, 0, 2]);
  assert.deepEqual(indexes('requests-desc'), [1, 0, 2]);
});
