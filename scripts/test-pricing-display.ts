import assert from 'node:assert/strict';
import { compareModelNames, groupPricingModels, pagePricingGroups } from '../web/src/types/pricingGroups.ts';
import { pricingProviderIdentity, pricingModelIdentity } from '../web/src/components/pricing/pricingIdentity.ts';
import type { PricingProvider } from '../web/src/types/pricing.ts';
import {
  formatHHMM,
  formatMultiplier,
  formatRatePer1M,
  formatUsd,
  modeOf,
  matchesModelSearch,
  newTierDraft,
  previewCostUsd,
  rateDelta,
  searchUpstreamModels,
  selectTier,
  tierDraftsFrom,
  tiersFromDrafts,
  upstreamAuthor,
} from '../web/src/types/pricingDisplay.ts';
import type { PriceTier, UpstreamModel } from '../web/src/types/pricing.ts';

/**
 * The price book's pure helpers.
 *
 * The editor previews a price with the same tier rule the server locks requests with, so a
 * preview that picked a different tier would show the operator one cost and bill another. The
 * tier cases below are the server's own (internal/pricing/quote_test.go), restated here.
 */
let cases = 0;
const check = (label: string, fn: () => void) => {
  fn();
  cases += 1;
  void label;
};

const at = (hour: number, minute: number) => Date.UTC(2026, 8, 28, hour, minute);

check('rates keep their exact decimals and never round to a cent', () => {
  assert.equal(formatRatePer1M(3), '$3.00');
  assert.equal(formatRatePer1M(0.075), '$0.075');
  assert.equal(formatRatePer1M(0.0416666666666667), '$0.041667');
  assert.equal(formatRatePer1M(null), '—');
});

check('money is sized to its magnitude', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(1234.5), '$1,234.50');
  assert.equal(formatUsd(3.456), '$3.46');
  assert.equal(formatUsd(0.0512), '$0.0512');
  assert.equal(formatUsd(0.000123), '$0.000123');
  assert.equal(formatUsd(undefined), '—');
  assert.equal(formatMultiplier(0.3), '×0.3');
  assert.equal(formatMultiplier(1), '×1');
  assert.equal(formatHHMM(0), '00:00');
  assert.equal(formatHHMM(1630), '16:30');
});

check('a long-context threshold applies at the threshold, not one token before', () => {
  const tiers: PriceTier[] = [{ min_prompt_tokens: 200_000, prompt_price_per_1m: 6 }, { min_prompt_tokens: 500_000, prompt_price_per_1m: 9 }];
  assert.equal(selectTier(tiers, 199_999, 0), -1);
  assert.equal(selectTier(tiers, 200_000, 0), 0);
  assert.equal(selectTier(tiers, 600_000, 0), 1, 'the highest eligible threshold wins');
});

check('a window wraps past midnight and is half-open', () => {
  const tiers: PriceTier[] = [{ utc_start: 1600, utc_end: 0, prompt_price_per_1m: 0.5 }];
  assert.equal(selectTier(tiers, 1, at(15, 59)), -1);
  assert.equal(selectTier(tiers, 1, at(16, 0)), 0);
  assert.equal(selectTier(tiers, 1, at(23, 59)), 0);
  assert.equal(selectTier(tiers, 1, at(0, 0)), -1);
  assert.equal(selectTier([{ utc_start: 900, utc_end: 900 }], 1, at(9, 0)), -1, 'an empty window never applies');
});

check('among tiers that apply, a windowed one beats an unwindowed one at the same threshold', () => {
  const tiers: PriceTier[] = [{ min_prompt_tokens: 100 }, { utc_start: 0, utc_end: 2359 }, { min_prompt_tokens: 100, utc_start: 0, utc_end: 2359 }];
  assert.equal(selectTier(tiers, 500, at(12, 0)), 2);
  assert.equal(selectTier(tiers, 50, at(12, 0)), 1);
});

check('the preview prices uncached input, cache buckets and both multipliers like the server', () => {
  const price = { prompt_price_per_1m: 3, completion_price_per_1m: 15, cache_read_price_per_1m: 0.3, cache_write_price_per_1m: 3.75, price_multiplier: 1.2, tiers: [] };
  const { usd, tierIndex } = previewCostUsd(price, { input: 2_000_000, output: 1_000_000, cache_read: 1_000_000, cache_write: 0 }, { channelMultiplier: 0.5 });
  assert.equal(tierIndex, -1);
  assert.ok(Math.abs(usd - (1 * 3 + 1 * 15 + 1 * 0.3) * 1.2 * 0.5) < 1e-9, `preview ${usd}`);
  const tiered = previewCostUsd({ ...price, price_multiplier: 1, tiers: [{ min_prompt_tokens: 200_000, prompt_price_per_1m: 6 }] }, { input: 210_000, output: 0, cache_read: 150_000, cache_write: 0 });
  assert.equal(tiered.tierIndex, 0, 'cached tokens count toward the threshold');
  assert.ok(Math.abs(tiered.usd - (60_000 * 6 + 150_000 * 0.3) / 1e6) < 1e-12, 'the tier inherits the base cache rate it does not set');
});

check('tier drafts round-trip and refuse what the server would refuse', () => {
  const tiers: PriceTier[] = [{ min_prompt_tokens: 200_000, prompt_price_per_1m: 6 }, { utc_start: 1600, utc_end: 0, completion_price_per_1m: 0.33 }];
  const back = tiersFromDrafts(tierDraftsFrom(tiers));
  assert.ok('tiers' in back);
  assert.deepEqual(back.tiers, tiers);
  assert.deepEqual(tiersFromDrafts([newTierDraft({ prompt: '1' })]), { error: 'condition', index: 0 });
  assert.deepEqual(tiersFromDrafts([newTierDraft({ utcStart: '16:00' })]), { error: 'window', index: 0 });
  assert.deepEqual(tiersFromDrafts([newTierDraft({ utcStart: '09:00', utcEnd: '09:00' })]), { error: 'window', index: 0 });
  assert.deepEqual(tiersFromDrafts([newTierDraft({ minPromptTokens: '1000', prompt: '-1' })]), { error: 'rate', index: 0 });
  assert.deepEqual(tiersFromDrafts([newTierDraft({ minPromptTokens: '1.5' })]), { error: 'condition', index: 0 });
});

check('the mode falls back from the source when a row carries none', () => {
  assert.equal(modeOf({ source: 'manual', match_kind: '' }), 'custom');
  assert.equal(modeOf({ source: 'openrouter', match_kind: 'linked' }), 'linked');
  assert.equal(modeOf({ source: 'modelsdev', match_kind: '' }), 'auto');
  assert.equal(modeOf({ source: 'openrouter', match_kind: 'exact', mode: 'linked' }), 'linked');
});

check('the picker ranks a model whose own name starts with the query first and aliases last', () => {
  const model = (id: string, name = ''): UpstreamModel => ({
    id, name, canonical_slug: id, author: upstreamAuthor(id), context_length: 0,
    prompt_price_per_1m: 1, completion_price_per_1m: 1, cache_read_price_per_1m: 1, cache_write_price_per_1m: 1, tiers: [],
  });
  const models = [model('~anthropic/claude-opus-latest'), model('anthropic/claude-opus-5.5'), model('openai/gpt-6-sol', 'OpenAI: GPT-6 Sol'), model('anthropic/old-claude-opus')];
  assert.deepEqual(searchUpstreamModels(models, 'claude-opus').map((item) => item.id), ['anthropic/claude-opus-5.5', '~anthropic/claude-opus-latest', 'anthropic/old-claude-opus']);
  assert.deepEqual(searchUpstreamModels(models, 'gpt sol').map((item) => item.id), ['openai/gpt-6-sol'], 'every word must match');
  assert.equal(upstreamAuthor('~anthropic/claude-opus-latest'), 'anthropic');
});

check('a rate change is stated relative to the reference, and a zero reference compares to nothing', () => {
  assert.equal(rateDelta(2, 3), 0.5);
  assert.equal(rateDelta(0, 3), null);
});


check('model search accepts separator variations and canonical names', () => {
  assert.equal(matchesModelSearch('GLM 5 3 Flash', 'z-ai/glm-5.3-flash'), true);
  assert.equal(matchesModelSearch('gpt 5 mini', 'openai/gpt-5.4-mini'), true);
  assert.equal(matchesModelSearch('gpt 5 mini', 'anthropic/claude-sonnet-4.5'), false);
  const models = [{ id: 'anthropic/claude-sonnet-4.5', name: 'Sonnet', canonical_slug: 'anthropic/claude-4-5-sonnet-20250929' }] as UpstreamModel[];
  assert.equal(searchUpstreamModels(models, '20250929')[0]?.id, models[0].id);
  assert.equal(searchUpstreamModels(models, 'claude 4 5 sonnet')[0]?.id, models[0].id);
});

check('provider groups preserve shared membership, priority and natural case order', () => {
  const provider = (id: string, priority: number, models: string[]): PricingProvider => ({ id, priority, models, name: id, family: 'codex', channel: 'codex', is_oauth: false });
  const rows = ['gpt-10', 'gpt-2', 'GPT-2', 'orphan'].map((model) => ({ model }));
  const groups = groupPricingModels(rows, [provider('Beta', 1, ['gpt-2']), provider('Alpha', 10, ['gpt-10', 'gpt-2', 'GPT-2', 'gpt-2'])]);
  assert.deepEqual(groups.map((group) => group.id), ['Alpha', 'Beta', 'unassigned']);
  assert.deepEqual(groups[0].rows.map((row) => row.model), ['GPT-2', 'gpt-2', 'gpt-10']);
  assert.equal(groups[1].rows[0].model, 'gpt-2', 'shared models remain in each actual provider');
  assert.equal(compareModelNames('model-9', 'model-10') < 0, true);
  assert.deepEqual(pagePricingGroups(groups, 1, 2).flatMap((group) => group.rows.map((row) => row.model)), ['GPT-2', 'gpt-2']);
  assert.deepEqual(pagePricingGroups(groups, 2, 2).flatMap((group) => group.rows.map((row) => row.model)), ['gpt-10', 'gpt-2']);
  assert.deepEqual(pagePricingGroups(groups, 3, 2).flatMap((group) => group.rows.map((row) => row.model)), ['orphan']);
});

check('pricing identity reuses provider overrides and keeps model names text-only', () => {
  const provider: PricingProvider = { id: 'relay-0', family: 'openai-compatibility', name: 'Production', endpoint_host: 'api.deepseek.com', channel: 'relay', priority: 1, is_oauth: false, models: [] };
  assert.equal(pricingProviderIdentity(provider).iconId, 'DeepSeek');
  assert.equal(pricingProviderIdentity({ ...provider, icon_id: 'Gemini' }).iconId, 'Gemini');
  assert.equal(pricingProviderIdentity({ ...provider, family: 'codex', name: 'codex', is_oauth: true }).label, 'Codex');
  assert.equal(pricingProviderIdentity({ ...provider, family: 'unknown-plugin', name: 'unknown-plugin', is_oauth: true }).iconId, '');
  assert.deepEqual(pricingModelIdentity('GPT-5'), { label: 'GPT-5' });
});

console.log(`pricing display: ${cases} cases passed`);
