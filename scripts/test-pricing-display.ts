import assert from 'node:assert/strict';
import { compareModelNames, groupPricingModels, pagePricingGroups } from '../web/src/types/pricingGroups.ts';
import { pricingProviderIdentity, pricingModelIdentity } from '../web/src/components/pricing/pricingIdentity.ts';
import type { PricingProvider } from '../web/src/types/pricing.ts';
import {
  convertTierDraftUnit,
  formatHHMM,
  formatMultiplier,
  formatRatePer1M,
  formatTokenCount,
  formatUsd,
  modeOf,
  matchesModelSearch,
  newTierDraft,
  parseTokenCount,
  previewCostUsd,
  priceSchedule,
  rateDelta,
  searchUpstreamModels,
  selectTier,
  shiftClockText,
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

const BASE = { prompt_price_per_1m: 3, completion_price_per_1m: 15, cache_read_price_per_1m: 0.3, cache_write_price_per_1m: 3.75 };

check('tier drafts round-trip and refuse what the server would refuse', () => {
  const tiers: PriceTier[] = [{ min_prompt_tokens: 200_000, prompt_price_per_1m: 6 }, { utc_start: 1600, utc_end: 0, completion_price_per_1m: 0.33 }];
  const back = tiersFromDrafts(tierDraftsFrom(tiers));
  assert.ok('tiers' in back);
  assert.deepEqual(back.tiers, tiers);
  assert.deepEqual(tiersFromDrafts([newTierDraft({ rateUnit: 'price', prompt: '1' })]), { error: 'condition', index: 0 });
  assert.deepEqual(tiersFromDrafts([newTierDraft({ kind: 'window', utcStart: '16:00' })]), { error: 'window', index: 0 });
  assert.deepEqual(tiersFromDrafts([newTierDraft({ kind: 'window', utcStart: '09:00', utcEnd: '09:00' })]), { error: 'window', index: 0 });
  assert.deepEqual(tiersFromDrafts([newTierDraft({ minPromptTokens: '1000', rateUnit: 'price', prompt: '-1' })]), { error: 'rate', index: 0 });
  assert.deepEqual(tiersFromDrafts([newTierDraft({ minPromptTokens: '1.5' })]), { error: 'condition', index: 0 });
  assert.deepEqual(tiersFromDrafts([newTierDraft({ minPromptTokens: '200K', prompt: '2' })]), { error: 'base', index: 0 }, 'a multiple needs a base');
  assert.deepEqual(
    tiersFromDrafts([newTierDraft({ minPromptTokens: '200K' }), newTierDraft({ minPromptTokens: '200000' })], BASE),
    { error: 'duplicate', index: 1 },
    'a second tier with the same conditions could never apply',
  );
});

check('a long-context tier limited to a window keeps both conditions, and an unticked window is dropped', () => {
  const windowed = tiersFromDrafts([newTierDraft({ minPromptTokens: '128K', isWindowed: true, utcStart: '16:30', utcEnd: '00:30' })], BASE);
  assert.deepEqual(windowed, { tiers: [{ min_prompt_tokens: 128_000, utc_start: 1630, utc_end: 30 }] });
  const unticked = tiersFromDrafts([newTierDraft({ minPromptTokens: '128K', isWindowed: false, utcStart: '16:30', utcEnd: '00:30' })], BASE);
  assert.deepEqual(unticked, { tiers: [{ min_prompt_tokens: 128_000 }] });
  const reopened = tierDraftsFrom([{ min_prompt_tokens: 128_000, utc_start: 1630, utc_end: 30 }], BASE)[0];
  assert.equal(reopened.kind, 'context');
  assert.equal(reopened.isWindowed, true);
});

check('multiples are priced from the base and written as rates the server stores', () => {
  const result = tiersFromDrafts([newTierDraft({ minPromptTokens: '200K', prompt: '2', completion: '1.5', cacheRead: '' })], BASE);
  assert.deepEqual(result, { tiers: [{ min_prompt_tokens: 200_000, prompt_price_per_1m: 6, completion_price_per_1m: 22.5 }] }, 'a blank multiple inherits');
  const noisy = tiersFromDrafts([newTierDraft({ kind: 'window', utcStart: '00:00', utcEnd: '08:00', prompt: '3' })], { ...BASE, prompt_price_per_1m: 0.1 });
  assert.ok('tiers' in noisy && noisy.tiers[0].prompt_price_per_1m === 0.3, 'float noise from multiplying is trimmed');
});

check('stored tiers reopen as multiples only when every rate is a readable multiple', () => {
  const published = tierDraftsFrom([{ min_prompt_tokens: 200_000, prompt_price_per_1m: 6, completion_price_per_1m: 22.5 }], BASE)[0];
  assert.equal(published.rateUnit, 'multiple');
  assert.deepEqual([published.minPromptTokens, published.prompt, published.completion, published.cacheRead], ['200K', '2', '1.5', '']);
  const odd = tierDraftsFrom([{ min_prompt_tokens: 200_000, prompt_price_per_1m: 4 }], BASE)[0];
  assert.equal(odd.rateUnit, 'price', '4 / 3 is not a multiple anyone published');
  assert.equal(odd.prompt, '4');
  assert.equal(tierDraftsFrom([{ utc_start: 0, utc_end: 800, prompt_price_per_1m: 1 }], { ...BASE, prompt_price_per_1m: 0 })[0].rateUnit, 'price', 'a zero base has no multiple');
  const back = tiersFromDrafts([published], BASE);
  assert.deepEqual(back, { tiers: [{ min_prompt_tokens: 200_000, prompt_price_per_1m: 6, completion_price_per_1m: 22.5 }] }, 'reopening and saving changes nothing');
});

check('switching how rates are entered keeps the price they describe', () => {
  const asMultiple = newTierDraft({ minPromptTokens: '200K', prompt: '2', completion: '' });
  const asPrice = convertTierDraftUnit(asMultiple, BASE, 'price');
  assert.deepEqual([asPrice.rateUnit, asPrice.prompt, asPrice.completion], ['price', '6', '']);
  assert.deepEqual(tiersFromDrafts([asPrice], BASE), tiersFromDrafts([asMultiple], BASE));
  assert.equal(convertTierDraftUnit(asPrice, BASE, 'multiple').prompt, '2');
});

check('long-context tiers are written before time-of-day tiers without changing which applies', () => {
  const drafts = [
    newTierDraft({ kind: 'window', utcStart: '16:00', utcEnd: '00:00', rateUnit: 'price', prompt: '1' }),
    newTierDraft({ minPromptTokens: '200K', rateUnit: 'price', prompt: '6' }),
  ];
  const result = tiersFromDrafts(drafts, BASE);
  assert.ok('tiers' in result);
  assert.equal(result.tiers[0].min_prompt_tokens, 200_000);
  assert.equal(result.tiers[1].utc_start, 1600);
  assert.equal(selectTier(result.tiers, 300_000, at(17, 0)), 0, 'the threshold still outranks the window');
});

check('token counts are read and written the way providers publish them', () => {
  assert.equal(parseTokenCount('200K'), 200_000);
  assert.equal(parseTokenCount('1m'), 1_000_000);
  assert.equal(parseTokenCount('1.5M'), 1_500_000);
  assert.equal(parseTokenCount('272,000'), 272_000);
  assert.equal(parseTokenCount(''), undefined);
  assert.ok(Number.isNaN(parseTokenCount('0')));
  assert.ok(Number.isNaN(parseTokenCount('1.5')));
  assert.ok(Number.isNaN(parseTokenCount('abc')));
  assert.equal(formatTokenCount(272_000), '272K');
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(131_072), '131072', 'a count that is not round stays exact');
});

check('a window shifts around the clock face between UTC and the console zone', () => {
  assert.equal(shiftClockText('16:00', 480), '00:00');
  assert.equal(shiftClockText('22:00', -240), '18:00');
  assert.equal(shiftClockText('02:00', -240), '22:00');
  assert.equal(shiftClockText('16:30', 345), '22:15');
  assert.equal(shiftClockText('', 480), '');
});

check('the price ladder reads from the base up, with inherited rates marked', () => {
  const rows = priceSchedule(BASE, [
    { utc_start: 1600, utc_end: 0, prompt_price_per_1m: 1.5 },
    { min_prompt_tokens: 500_000, prompt_price_per_1m: 9 },
    { min_prompt_tokens: 200_000, prompt_price_per_1m: 6, completion_price_per_1m: 22.5 },
  ]);
  assert.deepEqual(rows.map((row) => row.tierIndex), [-1, 2, 1, 0]);
  assert.equal(rows[0].upTo, 200_000, 'the base applies below the lowest threshold');
  assert.equal(rows[1].rates.cache_read_price_per_1m, 0.3);
  assert.deepEqual([...rows[1].inherited], ['cacheRead', 'cacheWrite']);
  assert.equal(priceSchedule(BASE, [{ utc_start: 0, utc_end: 800 }])[0].upTo, null, 'a window alone sets no upper bound');
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
