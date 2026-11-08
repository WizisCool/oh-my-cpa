import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { makeT, useI18n, type Lang } from '../src/i18n';
import { PluginStorePanel } from '../src/components/plugins/PluginStorePanel';
import { InstalledPluginsPanel } from '../src/components/plugins/InstalledPluginsPanel';
import { storeListingsByPluginId } from '../src/components/plugins/pluginStoreLogic';
import type { PluginItem, PluginStoreResponse, StorePluginItem } from '../src/types/plugin';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { PluginsPage } from '../src/pages/PluginsPage';

const entry: StorePluginItem = {
  store_id: 'registry-source/stable-plugin', source_id: 'registry-source', source_name: 'Publisher registry',
  id: 'stable-plugin', name: 'Base name', description: 'Base description', author: 'Base author',
  homepage: 'https://publisher.example', repository_url: 'https://github.com/publisher/stable-plugin',
  license: 'MIT', tags: ['base-tag'], platforms: ['linux/arm64'], version: '1.2.3',
  is_official: false, is_official_repository: false, is_omc: false, is_omc_repository: false,
  auth_required: false, auth_configured: false, installed: false, effective_enabled: false, update_available: false,
  locales: {
    'zh-CN': { name: '简体标题 & 保护', description: '<b>简体描述 & 保护</b>', author: '简体作者', homepage: 'https://publisher.example/zh?a=1&b=2', tags: ['简体标签 & 保护', '&lt;tag&gt;'] },
    'zh-Hant': { name: '繁體標題', description: '繁體描述', tags: ['繁體標籤'] },
    ms: { description: 'Keterangan penerbit' },
  },
};
const store: PluginStoreResponse = { plugins_enabled: true, plugins_dir: 'plugins', sources: [], source_errors: [], plugins: [entry], total: 1 };
const installed: PluginItem = {
  id: entry.id, configured: true, registered: true, enabled: true, effective_enabled: true,
  config_fields: [], metadata: { name: 'Runtime name', version: '1.0.0', author: 'Runtime author' },
};

function Catalog() {
  const { lang, setLang } = useI18n();
  return (
    <>
      <select aria-label="Catalog language" value={lang} onChange={(event) => setLang(event.target.value as Lang)}>
        {(['en', 'zh', 'zh-Hant', 'ms'] as const).map((value) => <option key={value}>{value}</option>)}
      </select>
      <PluginStorePanel store={store} isLoading={false} isDemo={false} onManage={() => {}} onOpenSettings={() => {}} />
      <InstalledPluginsPanel plugins={[installed]} catalog={storeListingsByPluginId([{ ...entry, installed: true, install_source_status: 'matched' }])} isLoading={false} isPluginSystemEnabled isDemo={false} onConfigure={() => {}} onBrowseStore={() => {}} onOpenSettings={() => {}} onCheckUpdates={async () => null} isCheckingUpdates={false} />
    </>
  );
}

it('updates catalog display, search and an open confirmation without changing installation identity', async () => {
  const server = installOmcApi();
  server.on('POST', `/management/plugin-store/${entry.id}/install`, () => ({ status: 'ok', id: entry.id, version: entry.version, plugins_enabled: true }));
  const { container } = renderWithOmc(<ThemeProvider><Catalog /></ThemeProvider>);
  const storePanel = await waitFor(() => {
    const panel = container.querySelector<HTMLElement>('[data-plugin-panel="store"]');
    expect(panel).not.toBeNull();
    return panel!;
  });
  const installedPanel = container.querySelector<HTMLElement>('[data-plugin-panel="installed"]')!;
  expect(within(storePanel).getByText('Base name')).toBeTruthy();
  expect(within(installedPanel).getByText('Runtime name')).toBeTruthy();
  fireEvent.click(within(storePanel).getByRole('button', { name: makeT('en')('plugin.install') }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('Base name');
  const language = screen.getByRole('combobox', { name: 'Catalog language' });
  fireEvent.change(language, { target: { value: 'zh' } });
  await waitFor(() => expect(dialog.textContent).toContain('简体标题'));
  for (const panel of [storePanel, installedPanel]) {
    expect(within(panel).getByText('简体标题 & 保护')).toBeTruthy();
    expect(within(panel).getByText('<b>简体描述 & 保护</b>')).toBeTruthy();
    expect(panel.querySelector('b')).toBeNull();
  }
  const homepage = storePanel.querySelector<HTMLAnchorElement>('a[href="https://publisher.example/zh?a=1&b=2"]');
  expect(homepage).not.toBeNull();
  expect(new URL(homepage!.href).searchParams.get('b')).toBe('2');
  expect(new URL(homepage!.href).searchParams.has('amp;b')).toBe(false);
  expect(within(storePanel).getByText('&lt;tag&gt;')).toBeTruthy();
  expect(storePanel.querySelector('tag')).toBeNull();
  expect(storePanel.querySelector('a[href="https://github.com/publisher/stable-plugin"]')).not.toBeNull();
  const search = within(storePanel).getByRole('textbox');
  fireEvent.change(search, { target: { value: '简体标签 & 保护' } });
  expect(storePanel.querySelector('[data-plugin-id="stable-plugin"]')).not.toBeNull();
  const installedSearch = within(installedPanel).getByRole('textbox');
  fireEvent.change(installedSearch, { target: { value: '简体描述 & 保护' } });
  expect(installedPanel.querySelector('[data-plugin-id="stable-plugin"]')).not.toBeNull();
  fireEvent.change(language, { target: { value: 'zh-Hant' } });
  await waitFor(() => expect(dialog.textContent).toContain('繁體標題'));
  expect(storePanel.querySelector('[data-plugin-id="stable-plugin"]')).toBeNull();
  expect(installedPanel.querySelector('[data-plugin-id="stable-plugin"]')).toBeNull();
  fireEvent.change(installedSearch, { target: { value: '' } });
  expect(within(installedPanel).getByText('繁體描述')).toBeTruthy();
  fireEvent.change(search, { target: { value: '繁體標籤' } });
  expect(within(storePanel).getByText('繁體標題')).toBeTruthy();
  // A localized name is never a valid acknowledgement of executable code.
  const confirmation = within(dialog).getByPlaceholderText(entry.id);
  const install = within(dialog).getByRole('button', { name: (name) => name.replace(/\s/g, '') === makeT('zh-Hant')('plugin.install') });
  fireEvent.change(confirmation, { target: { value: '繁體標題' } });
  expect((install as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(confirmation, { target: { value: entry.id } });
  expect((install as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(install);
  await waitFor(() => expect(server.writes('/install')).toHaveLength(1));
  expect(server.writes('/install')[0]).toMatchObject({ path: `/management/plugin-store/${entry.id}/install`, body: { source_id: entry.source_id } });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.change(language, { target: { value: 'ms' } });
  fireEvent.change(search, { target: { value: '' } });
  await waitFor(() => expect(within(storePanel).getByText('Keterangan penerbit')).toBeTruthy());
  expect(within(storePanel).getByText('Base name')).toBeTruthy();
  expect(within(installedPanel).getByText('Runtime name')).toBeTruthy();
  expect(storePanel.querySelector('a[href="https://publisher.example"]')).not.toBeNull();
});


it('keeps the runtime identity in search and delete confirmation when the catalog source differs', async () => {
  window.localStorage.setItem('omc-lang', 'zh');
  const server = installOmcApi();
  const foreignListing: StorePluginItem = {
    ...entry, installed: true, install_source_status: 'different',
    locales: { 'zh-CN': { name: 'Unrelated catalog name', author: 'Unrelated catalog author' } },
  };
  const { container } = renderWithOmc(
    <InstalledPluginsPanel plugins={[installed]} catalog={storeListingsByPluginId([foreignListing])} isLoading={false} isPluginSystemEnabled isDemo={false} onConfigure={() => {}} onBrowseStore={() => {}} onOpenSettings={() => {}} onCheckUpdates={async () => null} isCheckingUpdates={false} />,
  );
  expect(await screen.findByText('Runtime name')).toBeTruthy();
  expect(screen.getByText('Runtime author')).toBeTruthy();
  expect(screen.queryByText('Unrelated catalog name')).toBeNull();
  const search = screen.getByRole('textbox');
  fireEvent.change(search, { target: { value: 'Unrelated catalog' } });
  expect(container.querySelector('[data-plugin-id="stable-plugin"]')).toBeNull();
  fireEvent.change(search, { target: { value: 'Runtime name' } });
  expect(screen.getByText('Runtime name')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: `${makeT('zh')('common.more')}: Runtime name` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(makeT('zh')('plugin.delete')) }));
  expect(await screen.findByText(makeT('zh')('plugin.delete_confirm_title', { name: 'Runtime name' }))).toBeTruthy();
  expect(server.writes()).toHaveLength(0);
});

it('checks for updates on request and updates a plugin from its installed row', async () => {
  const server = installOmcApi();
  server.on('POST', `/management/plugin-store/${entry.id}/install`, () => ({ status: 'ok', id: entry.id, version: '1.3.0', plugins_enabled: true }));
  const newer = storeListingsByPluginId([{ ...entry, installed: true, installed_version: '1.0.0', version: '1.3.0', update_available: true, install_source_status: 'matched' }]);
  let checks = 0;
  function Installed() {
    // The page owns the store read; the panel only sees listings once updates were checked.
    const [catalog, setCatalog] = React.useState<ReadonlyMap<string, StorePluginItem>>(new Map());
    return (
      <InstalledPluginsPanel
        plugins={[installed]} catalog={catalog} isLoading={false} isPluginSystemEnabled isDemo={false}
        onConfigure={() => {}} onBrowseStore={() => {}} onOpenSettings={() => {}} isCheckingUpdates={false}
        onCheckUpdates={async () => {
          checks += 1;
          setCatalog(newer);
          return newer;
        }}
      />
    );
  }
  const t = makeT('en');
  const { container } = renderWithOmc(<Installed />);
  await screen.findByText('Runtime name');
  expect(container.querySelector('[data-testid="plugin-row-update"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('plugin.check_updates') }));
  expect(await screen.findByText(t('plugin.check_updates_found', { n: 1 }))).toBeTruthy();
  expect(checks).toBe(1);
  fireEvent.click(await screen.findByRole('button', { name: t('plugin.update_label_to', { name: 'Runtime name', version: 'v1.3.0' }) }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain(t('plugin.update_title', { name: 'Base name' }));
  // Updating replaces executable code, so a third-party plugin still asks for its id.
  fireEvent.change(within(dialog).getByPlaceholderText(entry.id), { target: { value: entry.id } });
  fireEvent.click(within(dialog).getByRole('button', { name: (name) => name.replace(/\s/g, '') === t('plugin.update') }));
  await waitFor(() => expect(server.writes('/install')).toHaveLength(1));
  expect(server.writes('/install')[0]).toMatchObject({ body: { source_id: entry.source_id } });
});

it('keeps background registry refresh separate from a manually requested update check', async () => {
  const server = installOmcApi({ plugins: [installed] });
  server.on('GET', '/management/plugin-store', () => store);
  server.on('PATCH', `/management/plugins/${installed.id}/enabled`, (_request, state) => {
    state.plugins = [{ ...installed, enabled: false, effective_enabled: false }];
    return { status: 'ok' };
  });
  const automatic = server.hold('GET', '/management/plugin-store');
  renderWithOmc(<ThemeProvider><PluginsPage /></ThemeProvider>, { route: '/plugins' });
  await automatic.arrived;
  const check = screen.getByTestId('plugin-check-updates');
  expect(check.classList.contains('ant-btn-loading')).toBe(false);
  await act(async () => automatic.release());

  const refresh = server.hold('GET', '/management/plugin-store');
  fireEvent.click(screen.getByRole('switch', { name: makeT('en')('plugin.toggle_label', { name: 'Runtime name' }) }));
  await refresh.arrived;
  expect(check.classList.contains('ant-btn-loading')).toBe(false);
  await act(async () => refresh.release());

  const manual = server.hold('GET', '/management/plugin-store');
  fireEvent.click(check);
  await manual.arrived;
  await waitFor(() => expect(check.classList.contains('ant-btn-loading')).toBe(true));
  await act(async () => manual.release());
  await waitFor(() => expect(check.classList.contains('ant-btn-loading')).toBe(false));
});

it('heads the store with the navigation label that led there', async () => {
  const server = installOmcApi();
  server.on('GET', '/management/plugin-store', () => store);
  const { container } = renderWithOmc(<ThemeProvider><PluginsPage /></ThemeProvider>, { route: '/plugins' });
  expect(await screen.findByRole('heading', { level: 1, name: makeT('en')('nav.plugins') })).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: makeT('en')('plugin.tab_store') }));
  // Switching the tab lands on the store's own address, and the head follows it: the store is a
  // navigation entry of its own, not a section the management title can name. Only the switch can
  // show this - a derivation tested on its own stays green while the page stops calling it.
  expect(await screen.findByRole('heading', { level: 1, name: makeT('en')('nav.plugin_store') })).toBeTruthy();
  await waitFor(() => expect(container.querySelector('[data-plugin-panel="store"]')).not.toBeNull());
});

it('persists plugin moves across filters and remounts without changing gateway order', async () => {
  const plugins = [installed, { ...installed, id: 'hidden', metadata: { name: 'Hidden' } }, { ...installed, id: 'last', metadata: { name: 'Runtime last' } }];
  const server = installOmcApi({ preferences: { omc_plugin_order: { installed: plugins.map((plugin) => plugin.id) } } });
  const panel = <InstalledPluginsPanel plugins={plugins} catalog={new Map()} isLoading={false} isPluginSystemEnabled isDemo={false} onConfigure={() => {}} onBrowseStore={() => {}} onOpenSettings={() => {}} onCheckUpdates={async () => null} isCheckingUpdates={false} />;
  const { container, unmount } = renderWithOmc(panel);
  const rows = () => [...container.querySelectorAll('[data-plugin-id]')].map((row) => row.getAttribute('data-plugin-id'));
  const label = `${makeT('en')('common.reorder_handle')}: Runtime last`;
  await screen.findByRole('button', { name: label });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Runtime' } });
  expect(rows()).toEqual([installed.id, 'last']);
  fireEvent.keyDown(screen.getByRole('button', { name: label }), { key: 'ArrowUp' });
  await waitFor(() => expect(server.preferenceWrites()).toEqual([{ key: 'omc_plugin_order', value: { installed: ['last', installed.id, 'hidden'] } }]));
  expect(rows()).toEqual(['last', installed.id]);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
  expect(rows()).toEqual(['last', installed.id, 'hidden']);
  expect(server.writes().every((request) => request.path.startsWith('/preferences/'))).toBe(true);
  unmount();
  const remount = renderWithOmc(panel);
  await waitFor(() => expect([...remount.container.querySelectorAll('[data-plugin-id]')].map((row) => row.getAttribute('data-plugin-id'))).toEqual(['last', installed.id, 'hidden']));
});

it('installs an Oh My CPA plugin in one step, asks a curated one for its id, and turns the source back on in place', async () => {
  const t = makeT('en');
  const omcSource = { id: 'omc', name: 'Oh My CPA', url: 'https://omc.example/registry.json', is_official: false, is_omc: true };
  const own: StorePluginItem = { ...entry, store_id: 'omc/own', source_id: 'omc', source_name: 'Oh My CPA', id: 'own', name: 'Own', locales: undefined, is_omc: true, is_omc_repository: true, repository_url: 'https://github.com/omc-community/own' };
  const curated: StorePluginItem = { ...own, store_id: 'omc/curated', id: 'curated', name: 'Curated', is_omc_repository: false, repository_url: 'https://github.com/author/curated' };
  const server = installOmcApi({ preferences: { omc_plugin_source_enabled: true } });
  server.on('POST', `/management/plugin-store/${own.id}/install`, () => ({ status: 'ok', id: own.id, version: own.version, plugins_enabled: true }));
  const emptySource = { id: 'empty', name: 'empty.example', url: 'https://empty.example/registry.json', is_official: false, is_omc: false };
  const omcStore: PluginStoreResponse = { ...store, sources: [omcSource, emptySource], plugins: [curated, own, entry] };
  const { container, unmount } = renderWithOmc(<ThemeProvider><PluginStorePanel store={omcStore} isLoading={false} isDemo={false} onManage={() => {}} onOpenSettings={() => {}} /></ThemeProvider>);
  const showcase = await waitFor(() => container.querySelector<HTMLElement>('[data-store-source="omc"]')!);
  // Only the plugins Oh My CPA maintains are featured; the ones it curates sit with the other catalogues.
  expect([...showcase.querySelectorAll('[data-plugin-id]')].map((card) => card.getAttribute('data-plugin-id'))).toEqual(['own']);
  const curatedSection = container.querySelector<HTMLElement>('[data-store-source="omc-community"]')!;
  expect(curatedSection.querySelector('[data-plugin-id="curated"]')).not.toBeNull();

  fireEvent.click(within(curatedSection.querySelector<HTMLElement>('[data-plugin-id="curated"]')!).getByRole('button', { name: t('plugin.install') }));
  let dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByPlaceholderText('curated')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: (name) => name.replace(/\s/g, '') === t('common.cancel').replace(/\s/g, '') }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  fireEvent.click(within(showcase.querySelector<HTMLElement>('[data-plugin-id="own"]')!).getByRole('button', { name: t('plugin.install') }));
  dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByRole('textbox')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: (name) => name.replace(/\s/g, '') === t('plugin.install') }));
  await waitFor(() => expect(server.writes('/install')).toHaveLength(1));
  expect(server.writes('/install')[0]).toMatchObject({ body: { source_id: 'omc' } });

  // A chosen source that lists nothing says so rather than leaving the page blank.
  fireEvent.mouseDown(screen.getByRole('combobox', { name: t('plugin.facet_label') }));
  fireEvent.click((await screen.findAllByText('empty.example')).at(-1)!);
  expect(await screen.findByText(t('plugin.source_empty'))).toBeTruthy();

  // A chosen source stays chosen when a search leaves none of its plugins, even one another source matches.
  fireEvent.mouseDown(screen.getByRole('combobox', { name: t('plugin.facet_label') }));
  // The open list repeats the label after the card's badge; the option is the last copy.
  fireEvent.click((await screen.findAllByText(t('plugin.badge_omc_community'))).at(-1)!);
  await waitFor(() => expect(container.querySelector('[data-store-source="omc"]')).toBeNull());
  fireEvent.change(within(container).getAllByRole('textbox')[0], { target: { value: 'Base name' } });
  expect(await screen.findByText(t('plugin.search_empty'))).toBeTruthy();
  expect(container.querySelector('[data-store-id]')).toBeNull();

  // Switched off, the section offers the switch rather than sending the operator elsewhere.
  unmount();
  server.state.preferences.omc_plugin_source_enabled = false;
  renderWithOmc(<ThemeProvider><PluginStorePanel store={{ ...store, plugins: [entry] }} isLoading={false} isDemo={false} onManage={() => {}} onOpenSettings={() => {}} /></ThemeProvider>);
  fireEvent.click(await screen.findByRole('button', { name: (name) => name.replace(/\s/g, '') === t('plugin.omc_source_enable').replace(/\s/g, '') }));
  await waitFor(() => expect(server.preferenceWrites()).toEqual([{ key: 'omc_plugin_source_enabled', value: true }]));
});
