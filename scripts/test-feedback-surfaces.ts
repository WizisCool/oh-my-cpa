import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOAST_ACTION_DURATION_SECONDS,
  TOAST_DURATION_SECONDS,
  groupToastItems,
  readableReason,
  summariseToastItems,
  toastDurationSeconds,
} from '../web/src/components/feedback/toastContent.ts';

test('an upstream JSON envelope reads as its status and sentence', () => {
  assert.equal(
    readableReason('CPA returned HTTP 502: {"error":"request failed"}'),
    'CPA returned HTTP 502 · request failed',
  );
  assert.equal(
    readableReason('upstream HTTP 429 {"error":{"message":"rate limited","type":"x"}}'),
    'upstream HTTP 429 · rate limited',
    'a nested error object is read for its message',
  );
});

test('a reason that is not an envelope is left as written', () => {
  assert.equal(readableReason('Provider does not support live refresh'), 'Provider does not support live refresh');
  // Broken JSON is not guessed at: the operator sees exactly what the server said.
  assert.equal(readableReason('CPA returned HTTP 502: {"error":'), 'CPA returned HTTP 502: {"error":');
});

test('items keep their groups in the order the caller listed them', () => {
  const groups = groupToastItems([
    { name: 'a.json', reason: 'boom', group: 'Failed' },
    { name: 'b.json', reason: 'off', group: 'Skipped', isGroupSummarised: true },
    { name: 'c.json', reason: 'boom', group: 'Failed' },
  ]);
  assert.deepEqual(groups.map((group) => [group.group, group.items.map((item) => item.name), group.isSummarised]), [
    ['Failed', ['a.json', 'c.json'], false],
    ['Skipped', ['b.json'], true],
  ]);
});

test('a summarised group is one line per reason, however many targets share it', () => {
  const summary = summariseToastItems([
    { name: 'a.json', reason: 'unsupported' },
    { name: 'b.json', reason: 'disabled' },
    { name: 'c.json', reason: 'unsupported' },
  ]);
  assert.deepEqual(summary, [
    { reason: 'unsupported', names: ['a.json', 'c.json'] },
    { reason: 'disabled', names: ['b.json'] },
  ]);
});

test('a toast with per-target reasons stays until it is closed', () => {
  assert.equal(toastDurationSeconds('warning', { items: [{ name: 'a.json', reason: 'boom' }] }), false);
  assert.equal(toastDurationSeconds('success', { isPersistent: true }), false);
  assert.equal(toastDurationSeconds('warning', { items: [] }), TOAST_DURATION_SECONDS.warning,
    'an empty list is not a report');
});

test('brief acknowledgements clear quickly while outcomes retain reading time', () => {
  assert.deepEqual(TOAST_DURATION_SECONDS, { success: 2, info: 3, warning: 4, error: 5 });
  for (const tone of ['success', 'info', 'warning', 'error'] as const) {
    assert.equal(toastDurationSeconds(tone, undefined), TOAST_DURATION_SECONDS[tone]);
    assert.equal(toastDurationSeconds(tone, { actions: 'View' }), 6);
  }
  assert.equal(TOAST_ACTION_DURATION_SECONDS, 6);
});

test('a success carrying a second line is not treated as a glance-only acknowledgement', () => {
  assert.equal(toastDurationSeconds('success', { detail: 'Changes take effect on new requests' }), 3);
  assert.equal(toastDurationSeconds('success', { error: new Error('Partial result') }), 3);
  assert.equal(toastDurationSeconds('success', { detail: '' }), 2);
  assert.equal(toastDurationSeconds('warning', { detail: 'Review the settings' }), 4);
});

test('persistent reports take precedence over actions and explicit durations', () => {
  assert.equal(toastDurationSeconds('warning', { items: [{ name: 'a.json' }], actions: 'View', durationSeconds: 1 }), false);
  assert.equal(toastDurationSeconds('success', { isPersistent: true, durationSeconds: 1 }), false);
  assert.equal(toastDurationSeconds('warning', { items: [] }), 4);
});

test('callers may override the default lifetime, including disabling auto-dismiss', () => {
  assert.equal(toastDurationSeconds('error', { durationSeconds: 2 }), 2);
  assert.equal(toastDurationSeconds('success', { actions: 'View', durationSeconds: 12 }), 12);
  assert.equal(toastDurationSeconds('success', { detail: 'Detail', durationSeconds: 0 }), 0);
});
