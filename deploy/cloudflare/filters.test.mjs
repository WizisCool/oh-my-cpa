import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { filterAuditEvents, filterServiceLogs } from './filters.mjs';

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
});

describe('the demonstration service log', () => {
  it('returns only what follows the last sequence seen', () => {
    const page = { records: [{ seq: 1 }, { seq: 2 }, { seq: 3 }], gap: false };
    const url = (query) => new URL(`https://demo.test/api/v1/management/service-logs${query}`);
    assert.equal(filterServiceLogs(page, url('')).records.length, 3);
    assert.deepEqual(filterServiceLogs(page, url('?after=2')).records, [{ seq: 3 }]);
  });
});
