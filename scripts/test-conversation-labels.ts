import assert from 'node:assert/strict';
import test from 'node:test';
import { failureKey, formatDuration, isKnownTurnStatus, playgroundErrorKey } from '../web/src/components/workspace/conversationLabels';
import * as agentState from '../web/src/pages/agent/state';
import * as playgroundErrors from '../web/src/pages/playground/errors';

test('page exports retain the shared presentation function identities', () => {
  assert.equal(agentState.failureKey, failureKey);
  assert.equal(agentState.formatDuration, formatDuration);
  assert.equal(agentState.isKnownTurnStatus, isKnownTurnStatus);
  assert.equal(playgroundErrors.playgroundErrorKey, playgroundErrorKey);
});

test('Agent status admission remains explicit and case-sensitive', () => {
  for (const status of ['running', 'pending', 'executing', 'success', 'error', 'rejected', 'expired', 'uncertain', 'partial', 'interrupted']) {
    assert.equal(isKnownTurnStatus(status), true, status);
  }
  for (const status of ['', 'cancelled', 'SUCCESS', 'teleported']) assert.equal(isKnownTurnStatus(status), false, status);
  assert.equal(agentState.turnLabelKey({ status: 'error', code: 'cancelled' }), 'agent.status.stopped');
  assert.equal(agentState.turnLabelKey({ status: 'teleported' }), 'agent.status.unknown');
});

test('Agent and Playground failure vocabularies retain separate keys and fallbacks', () => {
  const expectations = [
    ['gateway_auth_failed', 'agent.error.upstream_auth', 'pg.error.auth'],
    ['invalid_image', 'pg.error.image', 'pg.error.image'],
    ['demo_operation_refused', 'demo.blocked', 'demo.blocked'],
    ['budget_exceeded', 'agent.error.budget', 'pg.error.gateway'],
    ['playground_busy', 'agent.error.gateway', 'pg.error.busy'],
    ['operation_outcome_unknown', 'agent.error.uncertain', 'pg.error.gateway'],
    ['run_expired', 'workspace.error.run_missing', 'workspace.error.run_missing'],
    ['something_new_from_a_newer_server', 'agent.error.gateway', 'pg.error.gateway'],
  ];
  for (const [code, agentKey, playgroundKey] of expectations) {
    assert.equal(failureKey(code), agentKey, code);
    assert.equal(playgroundErrorKey(code), playgroundKey, code);
  }
});

test('duration labels retain rounding, unit thresholds and invalid-input behavior', () => {
  // Characterize existing rounding; normalization would change visible labels and needs separate approval.
  const expectations: [number, string][] = [
    [0, '0ms'], [420, '420ms'], [999.6, '1000ms'], [1000, '1.0s'],
    [4200, '4.2s'], [59_999, '60.0s'], [60_000, '1m 0s'], [72_000, '1m 12s'],
    [119_600, '1m 60s'], [120_000, '2m 0s'], [-1, '-'], [Number.NaN, '-'],
    [Number.POSITIVE_INFINITY, '-'], [Number.NEGATIVE_INFINITY, '-'],
  ];
  for (const [duration, label] of expectations) assert.equal(formatDuration(duration), label, String(duration));
});
