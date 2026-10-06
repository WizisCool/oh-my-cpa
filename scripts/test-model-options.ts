import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_MODEL_OPTIONS_DRAFT,
  buildModelOptions,
  countModelOptions,
  modelOptionsProblem,
  normalizeModalities,
  readModelOptionsDraft,
} from '../web/src/components/providers/modelOptions.ts';
import { PROVIDER_FAMILIES } from '../web/src/types/providerFamilies.ts';
import type { ProviderModelOptionField, ProviderModelOptions } from '../web/src/types/providers.ts';

const ALL_FIELDS: ProviderModelOptionField[] = [
  'max_context_length',
  'is_compat',
  'support_configuration_update',
  'modalities',
  'use_max_completion_tokens',
];

const stored: ProviderModelOptions = {
  display_name: 'GPT X',
  max_context_length: 128000,
  force_mapping: true,
  is_compat: true,
  support_configuration_update: true,
  input_modalities: ['text', 'image'],
  output_modalities: ['text'],
  use_max_completion_tokens: true,
  thinking_min: 1024,
  thinking_max: 32768,
  thinking_zero_allowed: true,
  thinking_dynamic_allowed: true,
};

test('reading and building a full entry returns it unchanged', () => {
  assert.deepEqual(buildModelOptions(readModelOptionsDraft(stored), ALL_FIELDS), stored);
});

test('a plain entry builds an empty object, which states that nothing is set', () => {
  assert.deepEqual(readModelOptionsDraft(undefined), EMPTY_MODEL_OPTIONS_DRAFT);
  assert.deepEqual(buildModelOptions(EMPTY_MODEL_OPTIONS_DRAFT, ALL_FIELDS), {});
  assert.equal(countModelOptions(EMPTY_MODEL_OPTIONS_DRAFT, ALL_FIELDS), 0);
});

test('a zero bound reads as unset, because CPA does not tell it from an absent one', () => {
  const draft = readModelOptionsDraft({ max_context_length: 0, thinking_min: 0, thinking_max: 0 });
  assert.equal(draft.maxContextLength, null);
  assert.equal(draft.thinkingMin, null);
  assert.equal(draft.thinkingMax, null);
});

test('only the settings the family has are named', () => {
  const draft = readModelOptionsDraft(stored);
  assert.deepEqual(buildModelOptions(draft, []), {
    display_name: 'GPT X',
    force_mapping: true,
    thinking_min: 1024,
    thinking_max: 32768,
    thinking_zero_allowed: true,
    thinking_dynamic_allowed: true,
  });
  const codex = buildModelOptions(draft, ['max_context_length', 'is_compat', 'support_configuration_update']);
  assert.equal(codex.support_configuration_update, true);
  assert.equal(codex.input_modalities, undefined);
  assert.equal(codex.use_max_completion_tokens, undefined);
  assert.equal(countModelOptions(draft, []), 6);
});

test('modalities are split, lowercased and deduplicated', () => {
  assert.deepEqual(normalizeModalities([' Text ', 'text', 'AUDIO,image', '']), ['text', 'audio', 'image']);
});

test('the display name is trimmed and dropped when blank', () => {
  const draft = { ...EMPTY_MODEL_OPTIONS_DRAFT, displayName: '  Named  ' };
  assert.deepEqual(buildModelOptions(draft, []), { display_name: 'Named' });
  assert.deepEqual(buildModelOptions({ ...draft, displayName: '   ' }, []), {});
});

test('bounds must be positive whole numbers in order', () => {
  const withBounds = (thinkingMin: number | null, thinkingMax: number | null) => ({
    ...EMPTY_MODEL_OPTIONS_DRAFT,
    thinkingMin,
    thinkingMax,
  });
  assert.equal(modelOptionsProblem(withBounds(1024, 1024), ALL_FIELDS), null);
  assert.equal(modelOptionsProblem(withBounds(null, 8192), ALL_FIELDS), null);
  assert.equal(modelOptionsProblem(withBounds(2048, 1024), ALL_FIELDS), 'thinking_order');
  assert.equal(modelOptionsProblem(withBounds(0, null), ALL_FIELDS), 'thinking_bounds');
  assert.equal(modelOptionsProblem(withBounds(null, 1.5), ALL_FIELDS), 'thinking_bounds');
  const badContext = { ...EMPTY_MODEL_OPTIONS_DRAFT, maxContextLength: -1 };
  assert.equal(modelOptionsProblem(badContext, ALL_FIELDS), 'context_length');
  // A family without the field never sends it, so its stale draft value is not a problem.
  assert.equal(modelOptionsProblem(badContext, []), null);
});

test('the family table matches the entries CPA declares', () => {
  const fieldsOf = (id: string) => PROVIDER_FAMILIES.find((family) => family.id === id)?.modelOptionFields ?? [];
  assert.deepEqual(fieldsOf('vertex'), []);
  assert.deepEqual(fieldsOf('claude'), ['max_context_length', 'is_compat']);
  for (const id of ['codex', 'xai', 'meta']) {
    assert.deepEqual(fieldsOf(id), ['max_context_length', 'is_compat', 'support_configuration_update'], id);
  }
  assert.deepEqual(fieldsOf('openai-compatibility'), [
    'max_context_length',
    'is_compat',
    'modalities',
    'use_max_completion_tokens',
  ]);
});
