/**
 * Display-mask parity between the console and the server.
 *
 * The key list and the request list render different sources — the live value
 * and the mask ingested with the event — so the only thing that keeps one key
 * reading the same way on both surfaces is the two implementations agreeing.
 * These assertions pin the frontend to `security.MaskSecret`'s branches: same
 * thresholds, same visible edges, same constant filler, and therefore the same
 * shape for the same key.
 *
 * The case that matters most is the one this console produces: `sk-cpa-` plus 32
 * hex characters is 39 runes and must render exactly 20 glyphs, so the row does
 * not resize when the secret is revealed.
 *
 * The fixture is an all-zero placeholder rather than a plausible-looking key: it
 * has the same 39 runes, so it exercises the same branch, and neither a reader nor
 * the repository's secret scanner can mistake it for a credential.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { maskKeyText } from '../web/src/utils/maskKey.ts';
import { maskAccount, maskAccountIn } from '../web/src/utils/maskAccount.ts';

const MASK_RUN = '••••••••';

test('a generated gateway key masks to a constant 20 glyphs', () => {
  const key = 'sk-cpa-00000000000000000000000000000000';
  assert.equal(key.length, 39);
  assert.equal(maskKeyText(key), `sk-cpa-0${MASK_RUN}0000`);
  assert.equal(maskKeyText(key).length, 20);
});

test('the mask keeps the same shape for every key long enough to have edges', () => {
  const shapes = [
    'sk-cpa-00000000000000000000000000000000',
    'sk-1234567890abcdefghij',
    'a'.repeat(64),
  ].map((key) => maskKeyText(key));
  for (const shape of shapes) {
    assert.equal(shape.length, 20);
    assert.ok(shape.includes(MASK_RUN));
  }
});

test('the middle-length branch matches the server thresholds', () => {
  // 12..19 runes: four visible head runes, four visible tail runes.
  assert.equal(maskKeyText('123456789012'), `1234${MASK_RUN}12`);
  assert.equal(maskKeyText('1234567890123456789'), `1234${MASK_RUN}89`);
  // 20 runes is the first length that gets the eight-rune head.
  assert.equal(maskKeyText('12345678901234567890'), `12345678${MASK_RUN}7890`);
});

test('a key too short for edges is masked completely', () => {
  // Exposing four of an eight-rune key would give away half the secret while
  // still failing to name it, so short keys are indistinguishable.
  for (const key of ['12345678901', 'abcdefgh', 'sk-1']) {
    assert.equal(maskKeyText(key), MASK_RUN);
  }
});

test('nothing and whitespace mask to nothing', () => {
  assert.equal(maskKeyText(''), '');
  assert.equal(maskKeyText('   '), '');
  assert.equal(maskKeyText(undefined), '');
});

test('the mask is not the secret and never contains its middle', () => {
  const key = 'sk-cpa-00000000000000000000000000000000';
  const masked = maskKeyText(key);
  assert.notEqual(masked, key);
  assert.ok(!masked.includes(key.slice(8, -4)));
  assert.ok(masked.includes(MASK_RUN));
});

// Masking an already-masked value returns it unchanged, for every branch.
//
// The management API sends a key's display mask by default and the value only to the
// page that opts in, so a reader that masks whatever it is handed - the dashboard's
// key picker - renders the same string either way. That holds only while the mask is
// idempotent: it is exactly head + filler + tail, so re-masking selects the same head
// and tail and leaves the filler alone, and the all-filler short-key branch is its own
// fixed point. A future shape change that broke this would make one page print a
// double-masked label, so the property is pinned rather than assumed.
//
// Short keys are the case worth naming: two of them share one mask by design, and a
// masked value is only 8 runes, which must not be re-read as a key with edges.
test('masking a mask returns the same mask', () => {
  for (const value of [
    'sk-cpa-00000000000000000000000000000000',
    'sk-1234567890abcdefghij',
    '123456789012',
    'abcdefgh',
    'sk-1',
  ]) {
    const masked = maskKeyText(value);
    assert.equal(maskKeyText(masked), masked);
  }
});

test('an account mask keeps the edges an owner recognises and hides the length', () => {
  const cases: Array<[string, string]> = [
    ['operator@example.com', 'op•••r@example.com'],
    ['abc.def@example.org', 'ab•••f@example.org'],
    ['abc@example.com', 'a•••@example.com'],
    ['vertex-prod-project', 'ver•••ct'],
    ['short', '•••'],
    ['', ''],
  ];
  for (const [account, masked] of cases) assert.equal(maskAccount(account), masked, account);
  assert.equal(maskAccountIn('antigravity-operator@example.com.json', 'operator@example.com'), 'antigravity-op•••r@example.com.json');
  // An address is case-insensitive, and a file name CPA derived from it may not match the
  // account's casing exactly. A case-sensitive lookup would print the whole address.
  assert.equal(
    maskAccountIn('antigravity-Operator@Example.com.json', 'operator@example.com'),
    'antigravity-op•••r@example.com.json',
  );
  // The account is a regex source, so metacharacters must be matched literally; the `$`
  // at the start of this local part would also be read as a replacement pattern if the
  // mask were passed as a plain string.
  assert.equal(maskAccountIn('codex+tag@example.com.json', 'codex+tag@example.com'), 'co•••g@example.com.json');
  assert.equal(maskAccountIn('codex-$&xy@example.com.json', '$&xy@example.com'), 'codex-$&•••y@example.com.json');
});
