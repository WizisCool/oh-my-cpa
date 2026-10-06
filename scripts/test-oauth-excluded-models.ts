import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeExcludedModels,
  excludedModelRulesEqual,
  filterCatalogModels,
  matchesExcludedModelRule,
  normalizeExcludedModelRules,
  setExcludedModelRule,
  validateExcludedModelRule,
} from '../web/src/components/authFiles/oauthExcludedModelLogic.ts';

const CATALOG = [
  { id: 'gpt-5', display_name: 'GPT-5' },
  { id: 'gpt-5-mini', display_name: 'GPT-5 mini' },
  { id: 'gpt-5-codex', display_name: 'gpt-5-codex' },
  { id: 'gpt-4.1' },
  { id: 'o3' },
];

test('rules are stored the way CPA applies them', () => {
  assert.deepEqual(
    normalizeExcludedModelRules([' GPT-5 ', 'gpt-5', '', 'O3-*', 'o3-*']),
    ['gpt-5', 'o3-*'],
  );
});

test('only the asterisk is a wildcard', () => {
  assert.equal(matchesExcludedModelRule('gpt-5', 'GPT-5'), true);
  assert.equal(matchesExcludedModelRule('gpt-5', 'gpt-5-mini'), false);
  assert.equal(matchesExcludedModelRule('gpt-5-*', 'gpt-5-mini'), true);
  assert.equal(matchesExcludedModelRule('gpt-5-*', 'gpt-5'), false);
  assert.equal(matchesExcludedModelRule('*-mini', 'gpt-5-mini'), true);
  assert.equal(matchesExcludedModelRule('gpt-*-codex', 'gpt-5-codex'), true);
  assert.equal(matchesExcludedModelRule('*', 'anything'), true);
  // A dot is a literal: a rule for 4.1 must not catch a model spelled 4x1.
  assert.equal(matchesExcludedModelRule('gpt-4.1', 'gpt-4x1'), false);
  assert.equal(matchesExcludedModelRule('gpt-4.*', 'gpt-4x1'), false);
  assert.equal(matchesExcludedModelRule('gpt-4.*', 'gpt-4.1'), true);
  // The prefix and the suffix may not share characters.
  assert.equal(matchesExcludedModelRule('ab*ba', 'aba'), false);
  assert.equal(matchesExcludedModelRule('ab*ba', 'abba'), true);
  assert.equal(matchesExcludedModelRule('', 'gpt-5'), false);
});

test('a typed rule is refused for the reason the operator can act on', () => {
  assert.equal(validateExcludedModelRule('  ', []), 'empty');
  assert.equal(validateExcludedModelRule('gpt-5 gpt-4', []), 'whitespace');
  assert.equal(validateExcludedModelRule('x'.repeat(257), []), 'too_long');
  assert.equal(validateExcludedModelRule('GPT-5', ['gpt-5']), 'duplicate');
  assert.equal(validateExcludedModelRule('new', Array.from({ length: 512 }, (_, index) => `m-${index}`)), 'too_many');
  assert.equal(validateExcludedModelRule('gpt-5-*', ['gpt-5']), undefined);
});

test('the view counts catalog models a rule covers, not rules', () => {
  const view = describeExcludedModels(['gpt-5', 'gpt-5-*', 'retired-model', 'claude-*'], CATALOG);
  assert.equal(view.totalCount, 5);
  assert.equal(view.excludedCount, 3);
  assert.equal(view.isEverythingExcluded, false);
  assert.deepEqual(view.typedRules, [
    { rule: 'gpt-5-*', isWildcard: true, matchCount: 2 },
    { rule: 'retired-model', isWildcard: false, matchCount: 0 },
    { rule: 'claude-*', isWildcard: true, matchCount: 0 },
  ]);
  const byId = Object.fromEntries(view.models.map((model) => [model.id, model]));
  assert.deepEqual(
    [byId['gpt-5'].isExactlyExcluded, byId['gpt-5'].patternRule],
    [true, undefined],
  );
  assert.deepEqual(
    [byId['gpt-5-mini'].isExcluded, byId['gpt-5-mini'].isExactlyExcluded, byId['gpt-5-mini'].patternRule],
    [true, false, 'gpt-5-*'],
  );
  assert.equal(byId['o3'].isExcluded, false);
  // A display name that only repeats the ID is not a second label.
  assert.equal(byId['gpt-5-codex'].displayName, undefined);
  assert.equal(byId['gpt-5'].displayName, 'GPT-5');
});

test('a model named by its own rule and by a pattern stays excluded when unchecked', () => {
  const rules = setExcludedModelRule(['gpt-5-mini', 'gpt-5-*'], 'GPT-5-Mini', false);
  assert.deepEqual(rules, ['gpt-5-*']);
  const model = describeExcludedModels(rules, CATALOG).models.find((entry) => entry.id === 'gpt-5-mini');
  assert.deepEqual([model?.isExcluded, model?.isExactlyExcluded, model?.patternRule], [true, false, 'gpt-5-*']);
});

test('the catch-all rule is reported as excluding everything', () => {
  const view = describeExcludedModels(['*'], CATALOG);
  assert.equal(view.isEverythingExcluded, true);
  assert.equal(view.excludedCount, 5);
  assert.deepEqual(view.typedRules, [{ rule: '*', isWildcard: true, matchCount: 5 }]);
});

test('without a catalog every rule is a typed rule', () => {
  const view = describeExcludedModels(['gpt-5', 'o3-*'], []);
  assert.equal(view.totalCount, 0);
  assert.deepEqual(view.typedRules.map((entry) => entry.rule), ['gpt-5', 'o3-*']);
});

test('toggling adds once and removes case-insensitively', () => {
  assert.deepEqual(setExcludedModelRule(['gpt-5'], 'GPT-5', true), ['gpt-5']);
  assert.deepEqual(setExcludedModelRule(['gpt-5'], 'o3', true), ['gpt-5', 'o3']);
  assert.deepEqual(setExcludedModelRule(['gpt-5', 'o3'], ' GPT-5 ', false), ['o3']);
});

test('rule order is not a change', () => {
  assert.equal(excludedModelRulesEqual(['a', 'b'], ['B', 'a']), true);
  assert.equal(excludedModelRulesEqual(['a'], ['a', 'b']), false);
  assert.equal(excludedModelRulesEqual([], []), true);
});

test('the catalog filter reads the ID and the display name', () => {
  const models = describeExcludedModels([], CATALOG).models;
  assert.deepEqual(filterCatalogModels(models, 'MINI').map((model) => model.id), ['gpt-5-mini']);
  assert.deepEqual(filterCatalogModels(models, 'gpt-5 m').map((model) => model.id), ['gpt-5-mini']);
  assert.equal(filterCatalogModels(models, '  ').length, 5);
});
