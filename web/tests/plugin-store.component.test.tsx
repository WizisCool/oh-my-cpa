import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { makeT, useI18n, type Lang } from '../src/i18n';
import { PluginStorePanel } from '../src/components/plugins/PluginStorePanel';
import { InstalledPluginsPanel } from '../src/components/plugins/InstalledPluginsPanel';
import { storeListingsByPluginId } from '../src/components/plugins/pluginStoreLogic';
import type { PluginItem, PluginStoreResponse, StorePluginItem } from '../src/types/plugin';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

const entry: StorePluginItem = {
  store_id: 'registry-source/stable-plugin', source_id: 'registry-source', source_name: 'Publisher registry',
  id: 'stable-plugin', name: 'Base name', description: 'Base description', author: 'Base author',
  homepage: 'https://publisher.example', repository_url: 'https://github.com/publisher/stable-plugin',
  license: 'MIT', tags: ['base-tag'], platforms: ['linux/arm64'], version: '1.2.3',
  is_official: false, is_official_repository: false, is_omc: false,
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
  const { container } = renderWithOmc(<Catalog />);
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
  fireEvent.click(await screen.findByRole('button', { name: t('plugin.update_label', { name: 'Runtime name' }) }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain(t('plugin.update_title', { name: 'Base name' }));
  // Updating replaces executable code, so a third-party plugin still asks for its id.
  fireEvent.change(within(dialog).getByPlaceholderText(entry.id), { target: { value: entry.id } });
  fireEvent.click(within(dialog).getByRole('button', { name: (name) => name.replace(/\s/g, '') === t('plugin.update') }));
  await waitFor(() => expect(server.writes('/install')).toHaveLength(1));
  expect(server.writes('/install')[0]).toMatchObject({ body: { source_id: entry.source_id } });
});
