import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditSearchParams,
  categoryOf,
  formatDetailValue,
  parseAuditSource,
  readableTarget,
  resultTone,
  type AuditEvent,
} from '../web/src/types/audit.ts';

const event = (fields: Partial<AuditEvent>): AuditEvent => ({
  id: 1,
  occurred_at_ms: 0,
  action: 'provider.update',
  target_type: 'provider',
  target_id: 'gemini',
  result: 'success',
  request_id: 'req-1',
  source_summary: '',
  ...fields,
});

test('a category covers every action prefix it names, and nothing that merely starts alike', () => {
  assert.equal(categoryOf('oauth_model_alias.update'), 'credentials');
  assert.equal(categoryOf('auth_file.delete'), 'credentials');
  assert.equal(categoryOf('auth.login'), 'access');
  assert.equal(categoryOf('capability.usage_aggregate'), 'agent');
  assert.equal(categoryOf('system.maintenance.checkpoint'), 'system');
  assert.equal(categoryOf('apixkey.create'), undefined);
});

test('a target is printed only when it names something a reader recognises', () => {
  assert.equal(readableTarget(event({ target_id: 'gemini' })), 'gemini');
  assert.equal(readableTarget(event({ target_id: 'list' })), undefined);
  assert.equal(readableTarget(event({ target_type: 'capability_operation', target_id: 'c4776c6d228a7bf0512d03e9' })), undefined);
  assert.equal(readableTarget(event({ target_id: 'client_key_alias:hmac:abc' })), undefined);
  assert.equal(readableTarget(event({ target_id: '0d1d9ba8837eb3270d1d9ba8837eb327' })), '0d1d9ba8…');
});

test('the source summary splits into its network and its client, the client keeping its spaces', () => {
  assert.deepEqual(parseAuditSource('ip=203.0.113.0/24 ua=Mozilla/5.0 (X11; Linux)'), {
    ip: '203.0.113.0/24',
    userAgent: 'Mozilla/5.0 (X11; Linux)',
  });
  assert.deepEqual(parseAuditSource(''), {});
});

test('an unfinished attempt is a warning and an unknown result carries no verdict', () => {
  assert.equal(resultTone('attempt'), 'warn');
  assert.equal(resultTone('failure'), 'danger');
  assert.equal(resultTone('checked'), 'success');
  assert.equal(resultTone('something-new'), 'neutral');
});

test('filters become the query the server reads, and defaults send nothing', () => {
  assert.equal(auditSearchParams({ categories: [], outcome: 'all', search: '  ' }).toString(), '');
  assert.equal(
    auditSearchParams({ categories: ['api_key', 'client_key'], outcome: 'failed', search: ' gem ' }).toString(),
    'category=api_key%2Cclient_key&outcome=failed&q=gem',
  );
});

test('detail values read as text, and structures as JSON', () => {
  assert.equal(formatDetailValue(['proxy_url', 'priority']), 'proxy_url, priority');
  assert.equal(formatDetailValue({ a: 1 }), '{"a":1}');
  assert.equal(formatDetailValue(null), '—');
  assert.equal(formatDetailValue(false), 'false');
});
