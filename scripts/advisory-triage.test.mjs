import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAdvisoryTriage } from './advisory-triage.mjs';
const finding = { id: 'GHSA-abcd-1234-abcd', package: 'fixture', owner: 'maintainer', reason: 'Pinned fixture', disposition: 'needs-fix', reviewBy: '2026-11-06' };
test('advisory ownership is exact, bounded and requires renewed review', () => {
  assert.doesNotThrow(() => validateAdvisoryTriage({ findings: [finding] }, '2026-10-07'));
  for (const mutate of [value => { value.owner = ''; }, value => { value.reason = ''; }, value => { value.id = 'all-high'; }, value => { value.reviewBy = '2026-10-07'; }]) {
    const value = { ...finding }; mutate(value);
    assert.throws(() => validateAdvisoryTriage({ findings: [value] }, '2026-10-07'));
  }
  assert.throws(() => validateAdvisoryTriage({ findings: [finding, finding] }, '2026-10-07'));
});
