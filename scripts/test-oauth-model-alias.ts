import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOAuthModelAliasDrafts,
  oauthModelAliasDraftsEqual,
  validateOAuthModelAliasDrafts,
} from '../web/src/components/authFiles/oauthModelAliasLogic.ts';

test('provider aliases normalize to the CPA channel keys', () => {
  const valid = validateOAuthModelAliasDrafts('anti-gravity', [
    { rowKey: 'row-1', name: 'claude-sonnet-4', alias: 'sonnet-latest' },
  ]);
  assert.deepEqual(valid, {
    ok: true,
    provider: 'antigravity',
    aliases: [{ name: 'claude-sonnet-4', alias: 'sonnet-latest' }],
  });

  const xai = validateOAuthModelAliasDrafts('x.ai', [
    { rowKey: 'row-1', name: 'grok-4', alias: 'grok-latest' },
  ]);
  assert.equal(xai.ok, true);
  if (xai.ok) assert.equal(xai.provider, 'xai');

  const underscored = validateOAuthModelAliasDrafts('my_provider', [
    { rowKey: 'row-1', name: 'upstream-model', alias: 'client-model' },
  ]);
  assert.equal(underscored.ok, true);
  if (underscored.ok) assert.equal(underscored.provider, 'my-provider');
});

test('model alias validation rejects shapes CPA silently drops', () => {
  assert.deepEqual(
    validateOAuthModelAliasDrafts('../codex', [{ rowKey: 'row-1', name: 'gpt-5', alias: 'fast' }]),
    { ok: false, error: 'provider' },
  );
  assert.deepEqual(
    validateOAuthModelAliasDrafts('a'.repeat(65), [{ rowKey: 'row-1', name: 'gpt-5', alias: 'fast' }]),
    { ok: false, error: 'provider' },
  );
  assert.deepEqual(
    validateOAuthModelAliasDrafts('codex', [{ rowKey: 'row-1', name: 'gpt-5', alias: 'gpt-5' }]),
    { ok: false, error: 'alias_same', alias: 'gpt-5' },
  );
  assert.deepEqual(
    validateOAuthModelAliasDrafts('codex', [
      { rowKey: 'row-1', name: 'gpt-5', alias: 'fast' },
      { rowKey: 'row-2', name: 'gpt-5.1', alias: 'FAST' },
    ]),
    { ok: false, error: 'alias_duplicate', alias: 'FAST' },
  );
  assert.deepEqual(
    validateOAuthModelAliasDrafts('codex', [{ rowKey: 'row-1', name: '', alias: 'fast' }]),
    { ok: false, error: 'name_alias_required' },
  );
});

test('dirty comparison ignores row identity but not mapping semantics', () => {
  const baseline = createOAuthModelAliasDrafts([
    { name: 'gpt-5', alias: 'fast', fork: true, display_name: 'Fast' },
  ]);
  const same = [{ ...baseline[0], rowKey: 'react-render-key' }];
  assert.equal(oauthModelAliasDraftsEqual(baseline, same), true);
  assert.equal(
    oauthModelAliasDraftsEqual(baseline, [{ ...same[0], force_mapping: true }]),
    false,
  );
});
