import assert from 'node:assert/strict';
import { sparkColor } from '../web/src/charts/chartTheme.ts';

/**
 * The dashboard mark is drawn by AntV, so there is no app-owned geometry left to
 * assert on. What stays app-owned - and therefore still worth pinning - is the
 * tone-to-token mapping: it is the contract that keeps a chart coloured from the
 * palette instead of from a literal, in both themes.
 */
const TONES = ['accent', 'success', 'warn', 'danger', 'neutral'] as const;

for (const tone of TONES) {
  for (const mode of ['dark', 'light'] as const) {
    const value = sparkColor(mode, tone);
    assert.match(value, /^#[0-9a-f]{6}$|^rgba?\(/, `${tone}/${mode} resolves to a colour token`);
  }
}

// The same tone must resolve per theme, not to one frozen literal: a chart that
// ignores the active mode is the regression this guards.
const darkAccent = sparkColor('dark', 'accent');
const lightAccent = sparkColor('light', 'accent');
const darkMuted = sparkColor('dark', 'neutral');

// Distinct tones stay distinguishable, so a tile's identity colour actually
// differs from its neighbour's and from the muted floor.
const resolved = new Set(TONES.map((tone) => sparkColor('dark', tone)));
assert.equal(resolved.size, TONES.length, 'each tone resolves to a distinct token');

// Neutral is the muted token, not an accent: the cache-rate and cost tiles rely
// on it reading as "no verdict".
assert.notEqual(darkMuted, darkAccent, 'neutral must not resolve to the accent');

// The accent is NOT mode-invariant: the two themes use different steps of one hue, because the
// bright step is legible on the dark background and illegible on the light one (6.03:1 vs 2.71:1).
// See docs/design.md §2 for the measured ladder. This assertion used to require the opposite, which
// is what a single accent value forced.
assert.notEqual(lightAccent, darkAccent, 'the accent resolves per theme');
assert.equal(darkAccent, '#00a2fb', 'the dark theme uses the bright step');
assert.equal(lightAccent, '#005d8f', 'the light theme uses the legible step');

console.log('PASS chart marks: tones resolve to distinct palette tokens per theme');
