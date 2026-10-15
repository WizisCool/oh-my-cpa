/**
 * Logic-level tests for the console rail's visibility setting.
 *
 * What is decided without a DOM is asserted here: which stored values count as a hidden set, what
 * hiding and showing do to it, that the entry owning the rail can never be hidden, and that the
 * filter the rail and the settings panel both read drops exactly the hidden entries and the group
 * headings they leave empty. That the rail actually redraws without them, and that the choice
 * survives a reload, is the `sidebar-customization` browser probe's claim.
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_HIDDEN_NAV,
  LOCKED_NAV_KEYS,
  hiddenNavSet,
  hideNavKey,
  isHideableNavKey,
  navEntryLabel,
  parseHiddenNavKeys,
  retainVisibleGroups,
  showNavKey,
  type NavGroup,
} from '../web/src/types/sidebarNav.ts';

const group = (key: string, labelKey: string, keys: string[]): NavGroup => ({
  key,
  labelKey,
  items: keys.map((itemKey) => ({ key: itemKey, labelKey: `nav.${itemKey}`, icon: null })),
});

const model = (): NavGroup[] => [
  group('operate', 'nav.group.operate', ['/dashboard', '/agent', '/playground']),
  group('observe', 'nav.group.observe', ['/logs', '/audit']),
  group('control', 'nav.group.control', ['/omc-settings']),
];

const keysOf = (groups: NavGroup[]) => groups.flatMap((entry) => entry.items.map((item) => item.key));

// ── the stored value is input, not state ────────────────────────────────────

assert.equal(parseHiddenNavKeys([])?.length, 0, 'an empty document is an empty hidden set');
assert.deepEqual(parseHiddenNavKeys(['/agent']), ['/agent']);
assert.deepEqual(parseHiddenNavKeys(['/agent', '/agent']), ['/agent'], 'a repeated key is stored once');
assert.equal(parseHiddenNavKeys('[/agent]'), undefined, 'a string is not a hidden set');
assert.equal(parseHiddenNavKeys({ hidden: ['/agent'] }), undefined, 'an object is not a hidden set');
assert.equal(parseHiddenNavKeys(null), undefined);
assert.equal(parseHiddenNavKeys(undefined), undefined);
assert.deepEqual(
  parseHiddenNavKeys(['/agent', 7, '', '   ', null, { key: '/logs' }, '/logs', 'x'.repeat(129), '/audit']),
  ['/agent', '   ', '/logs', '/audit'],
  'every value that is not a bounded non-empty string is dropped rather than trusted',
);
assert.deepEqual(parseHiddenNavKeys(['/omc-settings']), [], 'the entry that owns the rail is not hideable');

// ── what the rail can and cannot lose ───────────────────────────────────────

assert.equal(isHideableNavKey('/agent'), true);
assert.equal(isHideableNavKey('/omc-settings'), false);
assert.ok(LOCKED_NAV_KEYS.has('/omc-settings'), 'the settings entry is the locked one');
assert.equal(DEFAULT_HIDDEN_NAV.length, 0, 'nothing is hidden until the operator hides it');
assert.ok(Object.isFrozen(DEFAULT_HIDDEN_NAV), 'the fallback is module-scope and frozen for reference stability');

// ── hiding and showing ──────────────────────────────────────────────────────

assert.deepEqual(hideNavKey([], '/agent'), ['/agent']);
assert.deepEqual(hideNavKey(['/logs'], '/agent'), ['/agent', '/logs'], 'the hidden set is kept sorted');
assert.deepEqual(hideNavKey(['/agent'], '/agent'), ['/agent'], 'hiding a hidden entry changes nothing');
assert.deepEqual(hideNavKey([], '/omc-settings'), [], 'a locked entry cannot enter the hidden set');
assert.deepEqual(showNavKey(['/agent', '/logs'], '/agent'), ['/logs']);
assert.deepEqual(showNavKey([], '/agent'), [], 'showing a visible entry changes nothing');

const original = hideNavKey([], '/agent');
const next = hideNavKey(original, '/logs');
assert.deepEqual(original, ['/agent'], 'hiding returns a new set rather than mutating the current one');
assert.deepEqual(next, ['/agent', '/logs']);

// ── the filter the rail and the panel both read ─────────────────────────────

assert.deepEqual(keysOf(retainVisibleGroups(model(), hiddenNavSet([]))), keysOf(model()), 'nothing hidden means every entry');
assert.deepEqual(
  keysOf(retainVisibleGroups(model(), hiddenNavSet(['/agent']))),
  ['/dashboard', '/playground', '/logs', '/audit', '/omc-settings'],
  'a hidden entry leaves the rail and its group keeps the rest',
);
const thinned = retainVisibleGroups(model(), hiddenNavSet(['/logs', '/audit']));
assert.deepEqual(thinned.map((entry) => entry.key), ['operate', 'control'], 'a group with nothing left goes with its entries');
assert.deepEqual(thinned.map((entry) => entry.labelKey), ['nav.group.operate', 'nav.group.control'], 'the remaining groups keep their own order');
const untouched = model();
retainVisibleGroups(untouched, hiddenNavSet(['/agent']));
assert.deepEqual(keysOf(untouched), keysOf(model()), 'filtering does not mutate the model it is given');
// The filter itself knows nothing about the lock - it drops whatever set it is handed, which is
// why the lock has to hold where a set is built, at the stored document and at the toggle.
assert.deepEqual(
  retainVisibleGroups(model(), hiddenNavSet(parseHiddenNavKeys(['/omc-settings']) ?? [])).map((entry) => entry.key),
  ['operate', 'observe', 'control'],
  'the entry that owns the rail cannot be filtered out, because no stored document can name it',
);

// ── the label a row and a rail entry share ──────────────────────────────────

const t = (key: string) => `t:${key}`;
assert.equal(navEntryLabel({ key: '/agent', labelKey: 'nav.agent', icon: null }, t), 't:nav.agent');
assert.equal(
  navEntryLabel({ key: '/x', labelKey: 'Weather', isLiteralLabel: true, icon: null }, t),
  'Weather',
  'a plugin registers its own page label, which is not a translation key',
);

console.log('sidebar nav logic: ok');
