import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModelSquareEntries, buildModelReferenceLinks, classifyModelOpenness, countModelManufacturers, filterModelSquareEntries, isSafeReferenceURL, resolveEntryReference, resolveModelManufacturer, type ModelSquareDirectory, type ModelReference } from '../web/src/types/modelSquare.ts';
import { LOBE_ICON_CATALOG } from '../web/src/types/lobeIconCatalog.ts';

const GPT: ModelReference = { id: 'openai/gpt-5', name: 'GPT-5', open_weights: false, limit: { context: 400_000, output: 128_000 }, modalities: { input: ['text', 'image'], output: ['text'] } };
const DIRECTORY: ModelSquareDirectory = {
  models: ['team/fast', 'gpt-5', 'runtime-only'].map(id => ({ id, call_point: id, vision: 'unknown' })),
  metadata_updated_at: '2026-10-05', model_info: { 'gpt-5': GPT },
  providers: [], partial: [], routes: [
    { provider_id: 'relay', upstream_model: 'gpt-5', call_point: 'team/fast' },
    { provider_id: 'relay', upstream_model: 'claude-sonnet-4-5', call_point: 'team/fast' },
    { provider_id: 'oauth:codex', upstream_model: 'gpt-5', call_point: 'gpt-5' },
    { provider_id: 'hidden', upstream_model: 'ghost', call_point: 'not-advertised' },
  ],
};

test('available call points remain authoritative and fanout retains distinct model profiles', () => {
  const entries = buildModelSquareEntries(DIRECTORY, '');
  assert.equal(entries.length, 3);
  assert.equal(entries.find(entry => entry.identity === 'team/fast')?.manufacturer.id, 'multiple');
  assert.equal(entries.find(entry => entry.identity === 'team/fast')?.profiles.length, 2);
  assert.equal(entries.find(entry => entry.identity === 'gpt-5')?.profiles[0].metadata?.limit.context, 400_000);
  assert.equal(entries.find(entry => entry.identity === 'runtime-only')?.profiles[0].metadata, undefined);
  assert.equal(entries.find(entry => entry.identity === 'runtime-only')?.manufacturer.id, 'unknown');
});
test('search uses call points, manufacturers and exact model metadata without expanding availability', () => {
  assert.equal(buildModelSquareEntries(DIRECTORY, 'TEAM').length, 1);
  assert.equal(buildModelSquareEntries(DIRECTORY, 'GPT-5').length, 2);
  assert.equal(buildModelSquareEntries(DIRECTORY, 'OpenAI').length, 2);
  assert.equal(buildModelSquareEntries(DIRECTORY, 'not-advertised').length, 0);
  assert.equal(buildModelSquareEntries(DIRECTORY, 'missing').length, 0);
});
test('manufacturer artwork uses canonical maker identity, not relay branding', () => {
  assert.equal(resolveModelManufacturer('team/fast', GPT).id, 'openai');
  assert.equal(resolveModelManufacturer('experimental').id, 'unknown');
  assert.equal(resolveModelManufacturer('custom', { ...GPT, id: 'custom' }).id, 'unknown');
  assert.equal(resolveModelManufacturer('research/model', { ...GPT, id: 'research/model' }).id, 'research');
  assert.equal(resolveModelManufacturer('mygptish').id, 'unknown');
  assert.equal(resolveModelManufacturer('deepseek-r1-distill-qwen-32b').id, 'deepseek');
  assert.equal(resolveModelManufacturer('gpt-5-codex', { ...GPT, id: 'openai/gpt-5-codex' }).modelIconId, 'Codex');
  assert.equal(resolveModelManufacturer('google/gemma-3').modelIconId, 'Gemma');
});
test('external references preserve identity, use pi name search and never treat labels as URLs', () => {
  const links = buildModelReferenceLinks('team/fast', GPT);
  assert.equal(links[0].url, 'https://models.dev/models/openai/gpt-5');
  assert.equal(new URL(links[1].url).searchParams.get('q'), 'gpt-5');
  assert.equal(new URL(links[2].url).searchParams.get('name'), 'gpt-5');
  const unknown = buildModelReferenceLinks('strange/model & variant?x=1');
  assert.equal(unknown[0].url, 'https://models.dev/');
  assert.equal(new URL(unknown[2].url).searchParams.get('name'), 'model & variant?x=1');
  for (const link of unknown) assert.equal(isSafeReferenceURL(link.url), true);
  for (const value of ['javascript:alert(1)', 'http://example.test', 'https://secret@example.test', '/relative', 'not a url']) assert.equal(isSafeReferenceURL(value), false);
});
test('duplicate routes do not duplicate profiles or model labels', () => {
  const entries = buildModelSquareEntries({ ...DIRECTORY, routes: [...DIRECTORY.routes, DIRECTORY.routes[0]] }, '');
  assert.equal(entries.length, 3);
  assert.equal(entries.find(entry => entry.identity === 'team/fast')?.routes.length, 2);
});
test('connections naming one source model differently yield one profile, and unmatched names stay apart', () => {
  const shared = { id: 'meta/muse', name: 'Muse' };
  const [entry] = buildModelSquareEntries({
    models: [{ id: 'muse', call_point: 'muse', vision: 'unknown' }], providers: [], partial: [],
    routes: [
      { provider_id: 'relay-a', upstream_model: 'a/muse', call_point: 'muse' },
      { provider_id: 'relay-b', upstream_model: 'b/muse', call_point: 'muse' },
      { provider_id: 'relay-c', upstream_model: 'c/unknown-one', call_point: 'muse' },
      { provider_id: 'relay-d', upstream_model: 'd/unknown-two', call_point: 'muse' },
    ],
    model_info: { 'a/muse': shared, 'b/muse': shared },
  }, '');
  assert.deepEqual(entry.profiles.map(profile => profile.identity), ['a/muse', 'c/unknown-one', 'd/unknown-two']);
  assert.equal(entry.routes.length, 4);
});
test('recognized manufacturer and family marks exist in the offline catalog', () => {
  for (const model of ['gpt-5', 'claude-sonnet', 'gemini-pro', 'grok-4', 'qwen3', 'deepseek-r1', 'kimi-k2', 'glm-4', 'minimax-m2', 'mistral-large', 'llama-3', 'command-r', 'seed-1', 'mimo-v2', 'mercury-2', 'index-1.9b', 'phi-4', 'nova-pro', 'ernie-4', 'hunyuan-large', 'sonar-pro', 'nemotron-70b', 'step-2']) {
    const maker = resolveModelManufacturer(model);
    for (const iconId of [maker.iconId, maker.modelIconId]) assert.ok(LOBE_ICON_CATALOG.some(item => item.id === iconId), `${model}: ${iconId}`);
  }
});
test('named makers sort alphabetically ahead of the multiple and unidentified groups', () => {
  const directory: ModelSquareDirectory = { ...DIRECTORY, models: ['runtime-only', 'team/fast', 'gpt-5', 'claude-opus', 'zeta/model'].map(id => ({ id, call_point: id, vision: 'unknown' })), model_info: { ...DIRECTORY.model_info, 'zeta/model': { ...GPT, id: 'zeta/model' } } };
  assert.deepEqual(countModelManufacturers(buildModelSquareEntries(directory, '')).map(item => [item.manufacturer.id, item.count]), [['anthropic', 1], ['openai', 1], ['zeta', 1], ['multiple', 1], ['unknown', 1]]);
});
test('the maker filter keeps one maker and an empty filter keeps all', () => {
  const entries = buildModelSquareEntries(DIRECTORY, '');
  assert.deepEqual(filterModelSquareEntries(entries, 'openai').map(entry => entry.identity), ['gpt-5']);
  assert.equal(filterModelSquareEntries(entries, '').length, 3);
  assert.equal(filterModelSquareEntries(entries, 'absent').length, 0);
});
test('a row names a reference only when every target shares it', () => {
  const entries = buildModelSquareEntries(DIRECTORY, '');
  assert.equal(resolveEntryReference(entries.find(entry => entry.identity === 'gpt-5')!)?.id, 'openai/gpt-5');
  assert.equal(resolveEntryReference(entries.find(entry => entry.identity === 'team/fast')!), undefined);
  assert.equal(resolveEntryReference(entries.find(entry => entry.identity === 'runtime-only')!), undefined);
});
test('openness separates published weights from an open-source licence', () => {
  assert.equal(classifyModelOpenness({ open_weights: false }), 'closed');
  assert.equal(classifyModelOpenness({ open_weights: false, license: 'MIT' }), 'closed');
  assert.equal(classifyModelOpenness({}), undefined);
  assert.equal(classifyModelOpenness({ license: 'MIT' }), undefined);
  for (const license of ['MIT', 'MIT License', 'Apache 2.0', 'Apache-2.0', 'apache-2.0']) assert.equal(classifyModelOpenness({ open_weights: true, license }), 'open_source', license);
  for (const license of [undefined, '', 'CC-BY-NC-4.0', 'Llama 3.2 Community License', 'Mistral Research License', 'OpenMDW-1.1', 'Gemma', 'MIT-0-style']) assert.equal(classifyModelOpenness({ open_weights: true, license }), 'open_weights', String(license));
});
test('families the source does not describe still resolve to their maker', () => {
  for (const [model, maker] of [['mercury-2.5', 'inception'], ['index-mt-9b', 'bilibili'], ['phi-4', 'microsoft'], ['nova-pro', 'amazon'], ['ernie-4.5', 'baidu'], ['sonar-pro', 'perplexity'], ['gpt-oss-120b-medium', 'openai'], ['codex-auto-review', 'openai']]) assert.equal(resolveModelManufacturer(model).id, maker, model);
  for (const model of ['indexer', 'novation', 'stepwise', 'phil', 'openrouter/free']) assert.equal(resolveModelManufacturer(model).id, 'unknown', model);
  assert.equal(resolveModelManufacturer('cline-pass/glm-5.3-flash', { ...GPT, id: 'zhipuai/glm-5.3-flash' }).id, 'zai');
});
