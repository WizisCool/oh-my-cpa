import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pluginOwnsProvider } from '../web/src/types/pluginOAuthProviders';
import type { PluginItem } from '../web/src/types';
import {
  customIconID,
  clearCustomIconAssignments,
  canSaveCustomIcon,
  filterCustomIcons,
  shouldCloseIconPicker,
  resolveProviderArtwork,
  type CustomIcon,
} from '../web/src/types/customIcons';

test('custom references cannot collide with catalog marks or escape a URL segment', () => {
  const id = '0123456789abcdef0123456789abcdef';
  assert.equal(customIconID(`custom:${id}`), id);
  for (const reference of [
    'DeepSeek',
    'custom:../content',
    'custom:',
    'data:image/svg+xml,abc',
    undefined,
  ])
    assert.equal(customIconID(reference), undefined);
});
test('custom icon search preserves stable identities and uses the display name', () => {
  const icons = [
    { id: 'one', name: 'Team Relay' },
    { id: 'two', name: '个人图标' },
  ] as CustomIcon[];
  assert.deepEqual(filterCustomIcons(icons, '  TEAM  '), [icons[0]]);
  assert.deepEqual(filterCustomIcons(icons, '个人'), [icons[1]]);
  assert.deepEqual(filterCustomIcons(icons, ''), icons);
});
test('failed preference writes keep the icon picker open', () => {
  assert.equal(shouldCloseIconPicker(false), false);
  assert.equal(shouldCloseIconPicker(true), true);
  assert.equal(shouldCloseIconPicker(undefined), true);
});

test('plugin ownership is independent of logo availability or enablement', () => {
  const plugins = [
    {
      id: 'Relay',
      oauth_provider: 'relay-oauth',
      supports_oauth: true,
      enabled: false,
      logo: '',
    },
  ] as PluginItem[];
  assert.equal(pluginOwnsProvider(plugins, [' RELAY-OAUTH ']), true);
  assert.equal(pluginOwnsProvider(plugins, ['relay']), true);
  assert.equal(pluginOwnsProvider(plugins, ['other']), false);
});
test('plugin identity cannot be overridden when a logo is missing, broken or still loading', () => {
  const custom = 'custom:0123456789abcdef0123456789abcdef';
  assert.equal(
    resolveProviderArtwork(custom, 'OpenAI', false, false, false),
    custom,
  );
  for (const states of [
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ]) {
    assert.equal(
      resolveProviderArtwork(
        custom,
        'OpenAI',
        ...(states as [boolean, boolean, boolean]),
      ),
      'OpenAI',
    );
    assert.equal(
      resolveProviderArtwork(
        custom,
        undefined,
        ...(states as [boolean, boolean, boolean]),
      ),
      undefined,
    );
  }
  assert.equal(
    resolveProviderArtwork('DeepSeek', undefined, true, true, true),
    'DeepSeek',
  );
});

test('deletion clears identity and legacy assignments without changing unrelated icons', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const assignments = {
    'provider:one': `custom:${id}`,
    'Legacy name': `custom:${id}`,
    other: 'DeepSeek',
    another: 'custom:fedcba9876543210fedcba9876543210',
  };
  assert.deepEqual(clearCustomIconAssignments(assignments, id), {
    other: 'DeepSeek',
    another: assignments.another,
  });
  assert.equal(Object.keys(assignments).length, 4);
  assert.deepEqual(
    clearCustomIconAssignments(assignments, 'missing'),
    assignments,
  );
});

test('saving requires a changed name or validated replacement and preserves failed-input state', () => {
  const editing = {
    name: 'Team',
    originalName: 'Team',
    isNew: false,
    hasReplacement: false,
    hasValidatedPreview: false,
    isBusy: false,
  };
  assert.equal(canSaveCustomIcon(editing), false);
  assert.equal(canSaveCustomIcon({ ...editing, name: ' Renamed ' }), true);
  assert.equal(canSaveCustomIcon({ ...editing, name: ' Team ' }), false);
  for (const input of [
    { ...editing, isNew: true },
    { ...editing, name: 'Renamed', hasReplacement: true },
  ]) {
    assert.equal(canSaveCustomIcon(input), false);
    assert.equal(
      canSaveCustomIcon({ ...input, hasValidatedPreview: true }),
      true,
    );
  }
  for (const name of ['', '  ', '😀'.repeat(81)])
    assert.equal(canSaveCustomIcon({ ...editing, name }), false);
  assert.equal(canSaveCustomIcon({ ...editing, name: '😀'.repeat(80) }), true);
  assert.equal(
    canSaveCustomIcon({ ...editing, name: 'Renamed', isBusy: true }),
    false,
  );
});
