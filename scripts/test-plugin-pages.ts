import assert from 'node:assert/strict';
import {
  collectPluginPages,
  findPluginPage,
  pluginFrameShell,
  pluginPageFrameURL,
  pluginPageRoute,
} from '../web/src/components/plugins/pluginPages.ts';
import { pluginRuntimeStatus, waitForPluginRuntime } from '../web/src/components/plugins/pluginRuntime.ts';
import { isSecretPluginField, buildPluginConfigDraft, composePluginConfig, readPluginInstallRecord, undeclaredPluginKeys } from '../web/src/components/plugins/pluginConfigForm.ts';
import type { PluginItem, PluginsResponse } from '../web/src/types/plugin.ts';

function plugin(id: string, overrides: Partial<PluginItem> = {}): PluginItem {
  return { id, configured: true, registered: true, enabled: true, effective_enabled: true, config_fields: [], ...overrides };
}

// ── the pages plugins register ────────────────────────────────────────────────
const plugins: PluginItem[] = [
  plugin('bridge', {
    metadata: { name: 'Pass Bridge' },
    logo: 'data:image/png;base64,AAAA',
    pages: [{ path: '/v0/resource/plugins/bridge/console', label: 'Console', description: ' Accounts and usage ' }],
  }),
  plugin('multi', {
    pages: [
      { path: '/v0/resource/plugins/multi/status', label: 'Status' },
      { path: '/v0/resource/plugins/multi/logs', label: '' },
    ],
  }),
  // A stopped plugin serves nothing, whatever it still lists.
  plugin('stopped', { effective_enabled: false, pages: [{ path: '/v0/resource/plugins/stopped/ui', label: 'UI' }] }),
  // Only CPA's plugin resource tree is a plugin page.
  plugin('odd', {
    pages: [
      { path: '/v0/management/config', label: 'Config' },
      { path: 'https://elsewhere.example/', label: 'Elsewhere' },
      { path: '/v0/resource/plugins/odd/../../management/config', label: 'Traversal' },
    ],
  }),
  plugin('none'),
];
const entries = collectPluginPages(plugins);
assert.deepEqual(entries.map((entry) => entry.route), ['/plugin-pages/bridge/0', '/plugin-pages/multi/0', '/plugin-pages/multi/1']);
assert.equal(entries[0].navLabel, 'Console');
assert.equal(entries[0].pluginName, 'Pass Bridge');
assert.equal(entries[0].description, 'Accounts and usage');
assert.equal(entries[0].logo, 'data:image/png;base64,AAAA');
// A plugin with several pages is named in a list that mixes plugins; an unlabelled page takes the plugin's name.
assert.equal(entries[1].navLabel, 'multi · Status');
assert.equal(entries[2].label, 'multi');
assert.equal(entries[2].navLabel, 'multi');
assert.deepEqual(collectPluginPages(undefined), []);

assert.equal(pluginPageRoute('a b/c', 2), '/plugin-pages/a%20b%2Fc/2');
assert.equal(findPluginPage(entries, 'multi', '1')?.resourcePath, '/v0/resource/plugins/multi/logs');
assert.equal(findPluginPage(entries, 'multi', '2'), undefined);
assert.equal(findPluginPage(entries, 'multi', '1x'), undefined);
assert.equal(findPluginPage(entries, 'stopped', '0'), undefined);
assert.equal(findPluginPage(entries, undefined, '0'), undefined);

// The frame reads through the console's plugin host, under whatever sub-path the console is served from.
assert.equal(pluginPageFrameURL('/omc/api/v1', '/v0/resource/plugins/bridge/console'), '/omc/api/v1/plugin-host/v0/resource/plugins/bridge/console');
assert.equal(pluginPageFrameURL('/api/v1/', '/v0/resource/plugins/bridge/console'), '/api/v1/plugin-host/v0/resource/plugins/bridge/console');

const shell = pluginFrameShell('/omc/api/v1/plugin-host/v0/resource/plugins/bridge/console?a=1&b="2"', 'Con<sole>', 'dark');
assert.match(shell, /<html data-theme="dark" style="color-scheme:dark">/);
assert.ok(shell.includes('src="/omc/api/v1/plugin-host/v0/resource/plugins/bridge/console?a=1&amp;b=&quot;2&quot;"'));
assert.ok(shell.includes('title="Con&lt;sole&gt;"'));
assert.ok(shell.includes('referrerpolicy="no-referrer"'));

// ── waiting for the gateway to act on a switch ────────────────────────────────
function list(overrides: Partial<PluginItem>, isSystemEnabled = true): PluginsResponse {
  return { plugins_enabled: isSystemEnabled, plugins_dir: 'plugins', plugins: [plugin('bridge', overrides)], total: 1 };
}
assert.equal(pluginRuntimeStatus(list({}), 'bridge', true), 'ready');
assert.equal(pluginRuntimeStatus(list({ registered: false, effective_enabled: false }), 'bridge', true), 'pending');
assert.equal(pluginRuntimeStatus(list({ effective_enabled: false }, false), 'bridge', true), 'system-disabled');
assert.equal(pluginRuntimeStatus(list({}), 'bridge', false), 'pending');
assert.equal(pluginRuntimeStatus(list({ effective_enabled: false }), 'bridge', false), 'ready');
assert.equal(pluginRuntimeStatus(list({}), 'gone', false), 'ready');

function fakeClock() {
  let current = 0;
  const sleeps: number[] = [];
  return { sleeps, clock: { now: () => current, sleep: async (milliseconds: number) => { sleeps.push(milliseconds); current += milliseconds; } } };
}

{
  const responses = [list({ effective_enabled: false }), list({ effective_enabled: false }), list({})];
  const { clock, sleeps } = fakeClock();
  const result = await waitForPluginRuntime('bridge', true, async () => responses.shift() ?? list({}), clock, 15_000, 500);
  assert.equal(result.status, 'ready');
  assert.deepEqual(sleeps, [500, 500]);
}
{
  const { clock, sleeps } = fakeClock();
  let reads = 0;
  const result = await waitForPluginRuntime('bridge', true, async () => { reads += 1; return list({ effective_enabled: false }); }, clock, 1200, 500);
  assert.equal(result.status, 'timeout');
  // The last wait is cut to what is left of the budget, and the list is read once more after it.
  assert.deepEqual(sleeps, [500, 500, 200]);
  assert.equal(reads, 4);
}
{
  const { clock, sleeps } = fakeClock();
  const result = await waitForPluginRuntime('bridge', true, async () => list({ effective_enabled: false }, false), clock);
  assert.equal(result.status, 'system-disabled');
  assert.deepEqual(sleeps, []);
}

// ── settings form: a field is edited at once, and empty means the plugin's default ──
assert.equal(isSecretPluginField({ name: 'api-key', type: 'string' }), true);
assert.equal(isSecretPluginField({ name: 'upstream_token', type: 'string' }), true);
assert.equal(isSecretPluginField({ name: 'level', type: 'string' }), false);

{
  const fields = [{ name: 'options', type: 'object' }, { name: 'note', type: 'string' }];
  const draft = buildPluginConfigDraft(fields, { note: '' }, true);
  // An unset object starts empty rather than as `{}`, so opening the form writes nothing.
  assert.equal(draft.fields.options.text, '');
  assert.equal(draft.fields.options.isSet, false);
  // An explicit empty string in the stored document stays as stored.
  assert.deepEqual(composePluginConfig(draft, fields, { note: '' }).value, { note: '' });
}

{
  // CPA's install record is the host's key: carried through a form save untouched, shown
  // as where the plugin came from, and not listed among the keys nobody declared.
  const store = { name: 'Bridge', version: '0.2.12', repository: 'someone/bridge', homepage: ' https://bridge.example ', install: { type: 'github-release' } };
  const base = { enabled: true, store, legacy: 1 };
  const draft = buildPluginConfigDraft([], base, true);
  assert.deepEqual(composePluginConfig(draft, [], base).value, { legacy: 1, store, enabled: true });
  assert.deepEqual(undeclaredPluginKeys(base, []), ['legacy']);
  assert.deepEqual(readPluginInstallRecord(base), {
    name: 'Bridge', version: '0.2.12', author: undefined, license: undefined, description: undefined,
    homepage: 'https://bridge.example', repository: 'https://github.com/someone/bridge',
  });
  assert.equal(readPluginInstallRecord({ store: 'text' }), undefined);
  assert.equal(readPluginInstallRecord({}), undefined);
}

console.log('plugin pages, runtime waiting and settings defaults passed.');
