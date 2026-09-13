/**
 * Logic-level tests for the provider console's shared helpers.
 *
 * These run under the same plumbing as the other `scripts/test-*.ts` files:
 * Node's type stripping plus the resolver hook, with no test framework, so a
 * failing assertion exits non-zero and stops the script.
 */
import assert from 'node:assert/strict';
import { filterModelOptions, modelOptionsFor } from '../web/src/utils/modelOptions.ts';
import { isSafeExternalURL, safeExternalURL } from '../web/src/utils/externalUrl.ts';
import { parseProviderID, providerStatusPayload, FAMILY_BY_PROVIDER_ID_PREFIX } from '../web/src/types/providerId.ts';

// ---- provider ids: the list's key is not the API's family name ----

// The OpenAI-compatible family is abbreviated in the list id but spelled out on
// the wire. Forwarding the abbreviation would make the enable/disable toggle fail
// for exactly that family while working for the other three, which is the kind of
// asymmetry a click-through would not notice.
assert.deepEqual(parseProviderID('openai-compat-0'), { family: 'openai-compatibility', index: 0 });
assert.deepEqual(parseProviderID('openai-compat-12'), { family: 'openai-compatibility', index: 12 });
assert.deepEqual(parseProviderID('codex-3'), { family: 'codex', index: 3 });
assert.deepEqual(parseProviderID('claude-1'), { family: 'claude', index: 1 });
assert.deepEqual(parseProviderID('gemini-0'), { family: 'gemini', index: 0 });
assert.notEqual(
  FAMILY_BY_PROVIDER_ID_PREFIX['openai-compat'],
  'openai-compat',
  'the wire family must not be the list abbreviation',
);

// Anything unaddressable is refused rather than sent to an endpoint that would
// reject it as an unsupported family.
for (const bad of ['', '-1', 'openai-compat', 'openai-compat-', 'openai-compat-abc', 'openai-compat-1.5', 'nonsense-0', 'openai-compat--1']) {
  assert.equal(parseProviderID(bad), undefined, `${bad} must not parse`);
}

console.log('PASS provider ids: list abbreviation maps to the wire family, junk is refused');

// ---- the enabled/disabled inversion ----

// The control reasons in "is this provider on" and the endpoint takes the
// opposite field. Getting this backwards inverts every toggle - switching a
// provider off asks for it on, and the request succeeds while doing the reverse
// of what was clicked - so the conversion is pinned rather than left inline.
assert.deepEqual(providerStatusPayload('codex-0', true), {
  family: 'codex',
  index: 0,
  disabled: false,
});
assert.deepEqual(providerStatusPayload('codex-0', false), {
  family: 'codex',
  index: 0,
  disabled: true,
});
assert.deepEqual(providerStatusPayload('openai-compat-2', false), {
  family: 'openai-compatibility',
  index: 2,
  disabled: true,
});

// Switching a provider off must never ask for it to be switched on.
assert.equal(providerStatusPayload('claude-1', false)?.disabled, true, 'enabled=false means disabled=true');
assert.equal(providerStatusPayload('claude-1', true)?.disabled, false, 'enabled=true means disabled=false');

// An unaddressable id produces no request at all, rather than one against index
// zero of a family nobody named.
for (const bad of ['', 'openai-compat-', 'nonsense-0', 'codex-abc']) {
  assert.equal(providerStatusPayload(bad, true), undefined, `${bad} must not produce a payload`);
}

console.log('PASS provider status payload: the enabled/disabled inversion is stated once and pinned');

// ---- provider website: only a URL that can safely be an href ----

// The scheme is the security boundary. A javascript: or data: URL rendered into
// an href executes with the session's authority, so it must never be accepted.
for (const unsafe of [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  ' javascript:alert(1) ',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'ftp://example.test',
  'chrome://settings',
]) {
  assert.equal(isSafeExternalURL(unsafe), false, `${unsafe} must be refused`);
  assert.equal(safeExternalURL(unsafe), undefined, `${unsafe} must not become an href`);
}

// A scheme-relative or relative value would silently point at this console
// instead of at the provider, so it is refused rather than resolved.
for (const relative of ['//example.test', '/path', 'example.test', 'www.example.test', '?q=1', '#top']) {
  assert.equal(isSafeExternalURL(relative), false, `${relative} must be refused`);
}

// Absent is not an error, it is "no website": the row renders plain text.
for (const empty of ['', '   ', null, undefined]) {
  assert.equal(isSafeExternalURL(empty), false);
  assert.equal(safeExternalURL(empty), undefined);
}

for (const safe of [
  'http://example.test',
  'https://example.test',
  'https://example.test/path?q=1#frag',
  '  https://example.test  ',
  'https://api.deepseek.com',
]) {
  assert.equal(isSafeExternalURL(safe), true, `${safe} must be accepted`);
  assert.equal(safeExternalURL(safe), safe.trim(), 'the href is the trimmed value');
}

assert.equal(safeExternalURL('https://example.test:8443/v1'), 'https://example.test:8443/v1');

console.log(
  'PASS provider website: http/https only, script and relative schemes refused, absent means plain text',
);

// ---- model input filter ----

const MODELS = ['gpt-5.4', 'gpt-5.4-mini', 'GPT-4o', 'claude-sonnet-4', 'azure/gpt-5.4', 'deepseek-chat'];

// An empty query is the opening state and the state a cleared field returns to.
assert.deepEqual(filterModelOptions(MODELS, ''), MODELS);
assert.deepEqual(filterModelOptions(MODELS, '   '), MODELS);
assert.deepEqual(filterModelOptions([], 'gpt'), []);

// Case-insensitive, and a substring rather than a prefix: on a relay both
// `azure/gpt-5.4` and `gpt-5.4` are real ids and either may be the target.
assert.deepEqual(filterModelOptions(MODELS, 'GPT'), ['gpt-5.4', 'gpt-5.4-mini', 'GPT-4o', 'azure/gpt-5.4']);
assert.deepEqual(filterModelOptions(MODELS, 'gpt-5.4'), ['gpt-5.4', 'gpt-5.4-mini', 'azure/gpt-5.4']);
assert.deepEqual(filterModelOptions(MODELS, 'SONNET'), ['claude-sonnet-4']);
assert.deepEqual(filterModelOptions(MODELS, 'azure/'), ['azure/gpt-5.4']);
assert.deepEqual(filterModelOptions(MODELS, 'nothing-matches'), []);

// Surrounding whitespace is the operator's, not part of the model id.
assert.deepEqual(filterModelOptions(MODELS, '  deepseek  '), ['deepseek-chat']);

// The input list is never mutated: the fetched catalog is shared state.
const original = [...MODELS];
filterModelOptions(MODELS, 'gpt');
assert.deepEqual(MODELS, original);

console.log(
  'PASS model filter: case-insensitive substring, empty query shows all, input left untouched',
);

// ---- already-configured suppression ----

const configured = new Set(['gpt-5.4', 'claude-sonnet-4']);

// A model configured on another row is not offered again: CPA would accept the
// duplicate and the gateway would then have two entries competing for one model.
assert.deepEqual(modelOptionsFor(MODELS, '', configured), [
  'gpt-5.4-mini',
  'GPT-4o',
  'azure/gpt-5.4',
  'deepseek-chat',
]);

// The row's own value is kept even though it is in the configured set, or
// editing an existing model would empty its own dropdown.
assert.deepEqual(modelOptionsFor(MODELS, 'gpt-5.4', configured), [
  'gpt-5.4',
  'gpt-5.4-mini',
  'azure/gpt-5.4',
]);

// Typing a value that is configured elsewhere re-offers it, because that is the
// text the operator is entering and removing it would hide their own input.
assert.deepEqual(modelOptionsFor(MODELS, 'claude-sonnet-4', configured), ['claude-sonnet-4']);

// Suppression and the typed filter compose rather than one overriding the other:
// a configured-elsewhere model stays hidden while narrowing.
assert.deepEqual(modelOptionsFor(MODELS, 'gpt', configured), ['gpt-5.4-mini', 'GPT-4o', 'azure/gpt-5.4']);

// With nothing configured elsewhere the two functions agree.
assert.deepEqual(modelOptionsFor(MODELS, 'gpt', new Set()), filterModelOptions(MODELS, 'gpt'));

// A refreshed catalog is filtered the same way, so refreshing does not resurrect
// a duplicate: the suppression is applied at render, not baked into the fetch.
assert.deepEqual(
  modelOptionsFor([...MODELS, 'gpt-5.4'], '', configured),
  ['gpt-5.4-mini', 'GPT-4o', 'azure/gpt-5.4', 'deepseek-chat'],
);

console.log(
  'PASS model options: configured duplicates suppressed, own value kept, filter and suppression compose',
);
