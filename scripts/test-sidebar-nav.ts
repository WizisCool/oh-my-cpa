/**
 * Logic-level tests for the console rail's layout: which entries it shows, and in what order.
 *
 * What is decided without a DOM is asserted here: which stored values count as a hidden set or an
 * order, what hiding and showing do to the former, what dragging and stepping do to the latter, that
 * the entry owning the rail can never be hidden but can be moved, that a move across a group heading
 * changes nothing, and that the projection the rail and the settings panel both read drops exactly
 * the hidden entries - after ordering, so a hidden entry keeps its place - and the group headings
 * they leave empty. That the rail actually redraws without them, and that both choices survive a
 * reload, is the `sidebar-customization` browser probe's claim.
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_HIDDEN_NAV,
  DEFAULT_NAV_ORDER,
  LOCKED_NAV_KEYS,
  applyNavOrder,
  hiddenNavSet,
  hideNavKey,
  isHideableNavKey,
  moveNavEntry,
  navEntryLabel,
  parseHiddenNavKeys,
  parseNavOrder,
  retainVisibleGroups,
  showNavKey,
  stepNavEntry,
  type NavGroup,
  type NavOrder,
} from '../web/src/types/sidebarNav.ts';
import { test } from 'vitest';

test('sidebar nav', () => {
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
    navEntryLabel({ key: '/x', labelKey: 'Weather', isLiteralLabel: true, icon: null },
    t),
    'Weather',
    'a plugin registers its own page label, which is not a translation key',
  );

  // ── the stored order is input, not state ────────────────────────────────────

  assert.deepEqual(parseNavOrder({}), {}, 'an empty document is no stored order');
  assert.deepEqual(
    parseNavOrder({ operate: ['/agent', '/dashboard'] }),
    { operate: ['/agent', '/dashboard'] },
  );
  assert.deepEqual(
    parseNavOrder({ operate: ['/agent', '/agent', '/dashboard'] }),
    { operate: ['/agent', '/dashboard'] },
    'a repeated key keeps its first position',
  );
  assert.deepEqual(
    parseNavOrder({
      operate: ['/agent', 7, '', 'x'.repeat(129), '/dashboard'],
      observe: 'not-an-array',
      gateway: [],
      '': ['/logs'],
      ['g'.repeat(129)]: ['/audit'],
    }),
    { operate: ['/agent', '/dashboard'] },
    'a group that is not an array, an empty group, and a key that is not a bounded route key are dropped',
  );
  assert.equal(parseNavOrder([]), undefined, 'an array is not an order');
  assert.equal(parseNavOrder('{"operate":[]}'), undefined, 'a string is not an order');
  assert.equal(parseNavOrder(null), undefined);
  assert.equal(parseNavOrder(undefined), undefined);
  assert.deepEqual(
    parseNavOrder({ control: ['/system', '/omc-settings'] }),
    { control: ['/system', '/omc-settings'] },
    'the entry that owns the rail can be ordered - only hiding it is refused',
  );

  // ── the rail in the operator's order ────────────────────────────────────────

  const noOrder: NavOrder = {};
  const ordered = (order: NavOrder) =>
    applyNavOrder(model(), order).flatMap((entry) => entry.items.map((item) => item.key));

  assert.deepEqual(ordered(noOrder), keysOf(model()), 'no stored order reads the model as written');
  assert.deepEqual(
    applyNavOrder(model(), noOrder).map((entry) => entry.key),
    ['operate', 'observe', 'control'],
    'the groups keep their own order',
  );
  assert.deepEqual(
    ordered({ operate: ['/playground', '/dashboard', '/agent'] }),
    ['/playground', '/dashboard', '/agent', '/logs', '/audit', '/omc-settings'],
    'a group is reordered inside itself and the other groups are untouched',
  );
  assert.deepEqual(
    ordered({ operate: ['/playground'] }),
    ['/playground', '/dashboard', '/agent', '/logs', '/audit', '/omc-settings'],
    'a destination the document does not name is appended in the model\'s own order',
  );
  assert.deepEqual(
    ordered({ operate: ['/gone', '/dashboard'] }),
    ['/dashboard', '/agent', '/playground', '/logs', '/audit', '/omc-settings'],
    'a stored key that names no destination in the model is skipped, not drawn',
  );
  assert.deepEqual(
    ordered({ nowhere: ['/agent'] }),
    keysOf(model()),
    'a group the model does not have is not a group the rail draws',
  );
  assert.ok(Object.isFrozen(DEFAULT_NAV_ORDER), 'the fallback is module-scope and frozen for reference stability');
  assert.equal(Object.keys(DEFAULT_NAV_ORDER).length, 0, 'nothing is ordered until the operator orders it');

  // ── moving an entry ─────────────────────────────────────────────────────────

  const moved = moveNavEntry(model(), noOrder, '/playground', '/dashboard', 'before');
  assert.deepEqual(moved.operate, ['/playground', '/dashboard', '/agent'], 'a drop before a row lands before it');
  assert.deepEqual(
    Object.keys(moved),
    ['operate'],
    'only the group the entry moved in is written; the others stay as the model draws them',
  );
  assert.equal(
    moveNavEntry(model(), noOrder, '/dashboard', '/agent', 'before'),
    noOrder,
    'a drop that lands where the row already sits changes nothing at all',
  );

  const originalOrder: NavOrder = { operate: ['/playground', '/dashboard', '/agent'] };
  const stepped = moveNavEntry(model(), originalOrder, '/agent', '/playground', 'before');
  assert.deepEqual(stepped.operate, ['/agent', '/playground', '/dashboard']);
  assert.deepEqual(originalOrder.operate, ['/playground', '/dashboard', '/agent'], 'moving returns a new document');
  assert.equal(
    moveNavEntry(model(), originalOrder, '/dashboard', '/playground', 'after'),
    originalOrder,
    'a document that would come out identical is not replaced',
  );
  // A destination in another group cannot be a target: the groups say what an entry is, so a drop
  // across a heading is not an ordering choice and leaves the document exactly as it was.
  assert.equal(moveNavEntry(model(), originalOrder, '/agent', '/logs', 'before'), originalOrder, 'a cross-group move changes nothing at all');
  assert.equal(moveNavEntry(model(), originalOrder, '/agent', '/agent', 'before'), originalOrder, 'a drop onto itself changes nothing');
  assert.equal(moveNavEntry(model(), originalOrder, '/gone', '/agent', 'before'), originalOrder, 'a move naming no destination changes nothing');

  // A plugin page whose plugin stopped keeps its exact place, including when the operator moves an
  // entry in another group: the groups the move does not touch are carried over as they are, rather
  // than re-derived and having their unavailable keys pushed to the end.
  const withPlugins = (): NavGroup[] => [
    ...model().slice(0, 2),
    group('plugins', 'nav.group.plugins', ['/plugins', '/plugins/store']),
    ...model().slice(2),
  ];
  const stoppedFirst: NavOrder = { plugins: ['/plugin-pages/gone/0', '/plugins/store', '/plugins'] };
  const afterAnotherMove = moveNavEntry(withPlugins(), stoppedFirst, '/playground', '/dashboard', 'before');
  assert.equal(afterAnotherMove.plugins, stoppedFirst.plugins, 'a group the move does not touch is carried over as it is');
  assert.deepEqual(afterAnotherMove.operate, ['/playground', '/dashboard', '/agent']);
  assert.deepEqual(
    moveNavEntry(withPlugins(), stoppedFirst, '/plugins', '/plugins/store', 'before').plugins,
    ['/plugin-pages/gone/0', '/plugins', '/plugins/store'],
    'a move inside the group keeps a stopped destination where it was',
  );
  assert.deepEqual(
    moveNavEntry(withPlugins(), { plugins: ['/plugin-pages/gone/0', '/plugins'] }, '/plugins/store', '/plugins', 'before').plugins,
    ['/plugin-pages/gone/0', '/plugins/store', '/plugins'],
    'a destination the document does not name yet is appended, then moved',
  );

  // ── stepping an entry ───────────────────────────────────────────────────────

  assert.deepEqual(stepNavEntry(model(), noOrder, '/dashboard', 1).operate, ['/agent', '/dashboard', '/playground']);
  assert.equal(stepNavEntry(model(), noOrder, '/dashboard', -1), noOrder, 'the first entry cannot step earlier');
  assert.equal(stepNavEntry(model(), noOrder, '/playground', 1), noOrder, 'the last entry cannot step later');
  assert.equal(stepNavEntry(model(), noOrder, '/gone', 1), noOrder, 'stepping a destination the model does not have changes nothing');

  // ── ordering and hiding are independent ─────────────────────────────────────

  const rearranged = applyNavOrder(model(), { operate: ['/playground', '/dashboard', '/agent'] });
  assert.deepEqual(
    retainVisibleGroups(rearranged, hiddenNavSet(['/dashboard'])).flatMap((entry) => entry.items.map((item) => item.key)),
    ['/playground', '/agent', '/logs', '/audit', '/omc-settings'],
    'the hidden entry leaves the ordered rail and the entries around it keep their places',
  );
  assert.deepEqual(
    keysOf(model()),
    ['/dashboard', '/agent', '/playground', '/logs', '/audit', '/omc-settings'],
    'ordering does not mutate the model it is given',
  );
});
