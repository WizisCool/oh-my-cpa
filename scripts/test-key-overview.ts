/**
 * Logic-level tests for the key list's overview: the use tiles, the window's totals and the rows
 * the filters leave.
 */
import assert from 'node:assert/strict';
import { buildKeyRecords, summarizeKeys } from '../web/src/components/keys/keyOverview.ts';

const records = buildKeyRecords(
  ['sk-busy', 'sk-quiet', 'sk-unlinked'],
  [
    { index: 0, key: 'sk-busy', fingerprint: 'f1', usage_fingerprint: 'u1', length: 7, alias: 'Production', alias_version: 2 },
    { index: 1, key: 'sk-quiet', fingerprint: 'f2', usage_fingerprint: 'u2', length: 8, alias_version: 0 },
  ],
  {
    u1: { key_fingerprint: 'u1', requests: 200, failed: 4, total_tokens: 9_000, last_used_ms: 1 },
    u2: { key_fingerprint: 'u2', requests: 0, failed: 0, total_tokens: 0, last_used_ms: 0 },
  },
);

// ---- the join: names and traffic by key text, positions from CPA's order ----

assert.deepEqual(records.map((record) => [record.index, record.alias, record.usage?.requests]), [
  [0, 'Production', 200],
  [1, undefined, 0],
  [2, undefined, undefined],
]);
// A key with no stored traffic has no fingerprint, so its row id falls back to its position.
assert.equal(records[2].id, 'key-2');

// ---- the tiles: each counts what choosing it would show ----

const all = summarizeKeys(records, 'all', '', true);
assert.deepEqual(all.counts, { all: 3, active: 1, idle: 2 });
assert.equal(all.visible.length, 3);
assert.deepEqual(all.window, { requests: 200, failed: 4, successRate: 98 });

// A key never seen in stored traffic is idle, not unknown: the window was read and it is absent.
assert.deepEqual(summarizeKeys(records, 'idle', '', true).visible.map((record) => record.key), ['sk-quiet', 'sk-unlinked']);

// The counts follow the search, so a tile never promises rows the search has hidden.
const searched = summarizeKeys(records, 'active', 'prod', true);
assert.deepEqual(searched.counts, { all: 1, active: 1, idle: 0 });
assert.deepEqual(searched.visible.map((record) => record.key), ['sk-busy']);
// The window's totals do not: they describe the gateway, not the view.
assert.equal(searched.window?.requests, 200);

// ---- traffic not yet known: withheld, never counted as zero ----

const pending = summarizeKeys(records, 'active', '', false);
assert.equal(pending.counts, undefined);
assert.equal(pending.window, undefined);
// A use filter cannot be answered yet, so it narrows nothing rather than emptying the list.
assert.equal(pending.visible.length, 3);

// A window that served nothing has no success rate rather than a perfect one.
assert.equal(summarizeKeys(records.slice(1), 'all', '', true).window?.successRate, null);

console.log('key overview: ok');
