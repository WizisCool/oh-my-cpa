import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectModelMetadata } from './sync-model-metadata.mjs';

test('metadata projection retains only canonical facts and unambiguous source aliases', () => {
  const models = { 'maker/model': { id: 'maker/model', name: 'Model', open_weights: false, limit: { context: 123 }, cost: { input: 9 }, secret: 'discard' }, 'other/model': { id: 'other/model', name: 'Other' } };
  const providers = { relay: { models: { explicit: { canonical_model_id: 'maker/model' }, model: { canonical_model_id: 'maker/model' }, missing: { canonical_model_id: 'absent' } } } };
  const catalog = projectModelMetadata(models, providers);
  assert.equal(catalog.models['maker/model'].open_weights, false);
  assert.equal(catalog.models['maker/model'].secret, undefined);
  assert.equal(catalog.models['maker/model'].cost, undefined);
  assert.equal(catalog.aliases.explicit, 'maker/model');
  assert.equal(catalog.aliases['relay/explicit'], 'maker/model');
  assert.equal(catalog.aliases.model, undefined);
  assert.equal(catalog.aliases.missing, undefined);
  assert.throws(() => projectModelMetadata({ wrong: { id: 'different' } }, {}), /Invalid canonical/);
});
