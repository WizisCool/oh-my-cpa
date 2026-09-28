import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { filterAuditEvents, filterServiceLogs, summarizeAuditEvents } from './filters.mjs';

const TRAIL = {
  events: [
    { action: 'plugin.disable', result: 'failure', request_id: 'r3', target_type: 'plugin', target_id: 'logger' },
    { action: 'plugin.disable', result: 'attempt', request_id: 'r3', target_type: 'plugin', target_id: 'logger' },
    { action: 'provider.delete', result: 'attempt', request_id: 'r2', target_type: 'provider', target_id: 'gemini' },
    { action: 'api_key.reveal', result: 'success', request_id: 'r1', target_type: 'client_api_key', target_id: 'list' },
  ],
  next_cursor: '',
};

const read = (query) => filterAuditEvents(structuredClone(TRAIL), new URL(`https://demo.test/api/v1/management/audit/events${query}`));
const actions = (page) => page.events.map((event) => `${event.action}:${event.result}`);

describe('the demonstration audit trail', () => {
  it('folds an attempt into its outcome, but keeps an unfinished one', () => {
    assert.deepEqual(actions(read('')), ['plugin.disable:failure', 'provider.delete:attempt', 'api_key.reveal:success']);
    assert.equal(read('?fold=0').events.length, 4);
  });

  it('honours category, outcome and search like the server', () => {
    assert.deepEqual(actions(read('?category=api_key,provider')), ['provider.delete:attempt', 'api_key.reveal:success']);
    assert.deepEqual(actions(read('?outcome=failed')), ['plugin.disable:failure']);
    assert.deepEqual(actions(read('?q=GEMINI')), ['provider.delete:attempt']);
  });

  it('has no second page to give', () => {
    assert.deepEqual(read('?before=1_1').events, []);
  });

  it('keeps only unfinished operations when asked', () => {
    assert.deepEqual(actions(read('?outcome=unfinished')), ['provider.delete:attempt']);
  });

  it('moves the window onto the dataset calendar before applying it', () => {
    const dated = structuredClone(TRAIL);
    dated.events.forEach((event, index) => { event.occurred_at_ms = 1_000 * (4 - index); });
    const url = new URL('https://demo.test/api/v1/management/audit/events?since_ms=12500');
    // Re-based by +10s, the rows sit at 14s, 13s, 12s and 11s; folded, two are at or after 12.5s.
    assert.deepEqual(actions(filterAuditEvents(dated, url, { deltaMs: 10_000 })), ['plugin.disable:failure']);
  });

  it('summarizes the folded trail by prefix and outcome, ignoring category and outcome', () => {
    const dataset = { responses: { 'audit-events': { body: JSON.stringify(TRAIL) } } };
    const url = new URL('https://demo.test/api/v1/management/audit/summary?category=plugin&outcome=failed');
    assert.deepEqual(summarizeAuditEvents({ buckets: [] }, url, { dataset }).buckets, [
      { prefix: 'api_key', outcome: 'succeeded', count: 1 },
      { prefix: 'plugin', outcome: 'failed', count: 1 },
      { prefix: 'provider', outcome: 'unfinished', count: 1 },
    ]);
    const searched = new URL('https://demo.test/api/v1/management/audit/summary?q=gemini');
    assert.deepEqual(summarizeAuditEvents({ buckets: [] }, searched, { dataset }).buckets, [
      { prefix: 'provider', outcome: 'unfinished', count: 1 },
    ]);
  });
});

describe('the demonstration service log', () => {
  it('returns only what follows the last sequence seen', () => {
    const page = { records: [{ seq: 1 }, { seq: 2 }, { seq: 3 }], gap: false };
    const url = (query) => new URL(`https://demo.test/api/v1/management/service-logs${query}`);
    assert.equal(filterServiceLogs(page, url('')).records.length, 3);
    assert.deepEqual(filterServiceLogs(page, url('?after=2')).records, [{ seq: 3 }]);
    const limited = filterServiceLogs(page, url('?limit=1'));
    assert.deepEqual(limited.records, [{ seq: 3 }]);
    assert.equal(limited.gap, true);
  });
});
