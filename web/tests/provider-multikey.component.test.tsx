import providerCopy from '../src/i18n/locales/en/providers';
import { readConnectionPoolDraft } from '../src/components/providers/connectionPool';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useT } from '../src/i18n';
import { ProviderEditorDrawer } from '../src/components/providers/ProviderEditorDrawer';
import { useProviderManagement } from '../src/components/providers/useProviderManagement';
import { useProviderIconOverrides } from '../src/components/providers/useProviderIconOverrides';
import type { Toast } from '../src/components/feedback';
import { installOmcApi } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';

const toast: Toast = {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), pending: () => () => {}, dismiss: vi.fn(),
};

const renderEditor = (isCreate: boolean, withPool = false, hasInvalidKeyPool = false) => {
  const client = createTestQueryClient();
  client.setQueryData(['management-plugins'], { plugins: [] });
  return renderWithOmc(<Editor isCreate={isCreate} withPool={withPool} hasInvalidKeyPool={hasInvalidKeyPool} />, { client });
};

function Editor({ isCreate, withPool, hasInvalidKeyPool }: { isCreate: boolean; withPool: boolean; hasInvalidKeyPool: boolean }) {
  const t = useT();
  const icons = useProviderIconOverrides();
  const editor = useProviderManagement({ ...icons, t, toast, settleProviderRow: () => {} });
  return <>
    <button onClick={() => {
      if (isCreate) editor.handleOpenCreate();
      else editor.handleOpenEdit({ id: 'codex-0', family: 'codex', name: 'Relay', protocol: 'OpenAI Responses', base_url: 'https://relay.test', disabled: false, key_configured: true, auth_index: 'fixture-index', ...(withPool ? { connection_pool: { group_name: 'team', group_size: 3, defaults: { enabled: false, idle_conn_timeout: '300s', max_idle_conns_per_host: 2 } } } : {}) });
      editor.setFormFamily('codex');
      editor.setFormName('Relay');
      editor.setFormBaseURL('https://relay.test');
      editor.setFormIcon('DeepSeek');
      editor.setFormKeys([
        { connectionPool: withPool ? readConnectionPoolDraft(hasInvalidKeyPool ? { idle_conn_timeout: '1'.repeat(129) } : {}) : undefined, storedConnectionPool: withPool ? {} : undefined, id: 'first', apiKey: 'fixture-key-one', proxyUrl: 'http://proxy-one.test', weight: 3, isChanging: true },
        { id: 'second', apiKey: 'fixture-key-two', proxyUrl: 'http://proxy-two.test', weight: 7, isChanging: true },
      ]);
    }}>Load multi-key draft</button>
    <ProviderEditorDrawer {...editor} familyDisplayNames={{}} />
  </>;
}

it('saves every Codex key and assigns the selected icon to every returned row', async () => {
  const ids = ['codex-2', 'codex-3'];
  const api = installOmcApi({ preferences: { provider_icons: { 'codex-1': 'Anthropic' } } });
  api.on('*', /^\/management\/providers(\/codex-0)?$/, request => request.method === 'GET' ? undefined : { status: 'ok', family: 'codex', id: ids[0], ids });
  const writes = () => api.writes() as { path: string; method: string; body: Record<string, unknown> }[];
  const view = renderEditor(true);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Load multi-key draft' }));
    expect(await screen.findByText('Each API key is saved as a separate provider with the same shared settings.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[0].method).toBe('POST');
    expect(writes()[0].body).toMatchObject({ family: 'codex', keys: [
      { api_key: 'fixture-key-one', proxy_url: 'http://proxy-one.test', weight: 3 },
      { api_key: 'fixture-key-two', proxy_url: 'http://proxy-two.test', weight: 7 },
    ] });
    expect(writes()[2].body).toEqual({ 'codex-1': 'Anthropic', [ids[0]]: 'DeepSeek', [ids[1]]: 'DeepSeek' });
  } finally { view.unmount(); }
});

function RotationEditor() {
  const t = useT();
  const icons = useProviderIconOverrides();
  const editor = useProviderManagement({ ...icons, t, toast, settleProviderRow: () => {} });
  return <>
    <button onClick={() => {
      editor.handleOpenEdit({
        id: 'codex-0', family: 'codex', name: 'Relay', protocol: 'OpenAI Responses',
        base_url: 'https://relay.test', disabled: false, key_configured: true, auth_index: 'fixture-index',
        connection_pool: { group_name: 'team', group_size: 2, defaults: { enabled: true } },
        key_entries: [
          { index: 0, api_key: 'fixture-key-one', connection_pool: { enabled: false, max_idle_conns_per_host: 0 }, proxy_url: '', weight: 1 },
          { index: 1, api_key: 'fixture-key-two', proxy_url: '', weight: 1 },
        ],
      });
      editor.setFormFamily('claude');
    }}>Load key rotation</button>
    <ProviderEditorDrawer {...editor} familyDisplayNames={{}} />
  </>;
}

it('sends the stored row identity when a key is rotated to another family', async () => {
  const api = installOmcApi();
  api.on('PUT', '/management/providers/codex-0', () => ({ status: 'ok', family: 'claude', id: 'claude-0', ids: ['claude-0'] }));
  const client = createTestQueryClient();
  client.setQueryData(['management-plugins'], { plugins: [] });
  const view = renderWithOmc(<RotationEditor />, { client });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Load key rotation' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Key #1/ }));
    fireEvent.change(screen.getByDisplayValue('fixture-key-one'), { target: { value: 'fixture-key-rotated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.writes('/providers/codex-0')).toHaveLength(1));
    const body = api.writes('/providers/codex-0')[0].body as Record<string, unknown>;
    expect(body.family).toBe('claude');
    expect((body.keys as Record<string, unknown>[])[0]).toMatchObject({
      api_key: 'fixture-key-rotated',
      source_index: 0,
    });
  } finally { view.unmount(); }
});

it('saves only the edited connection pool layer', async () => {
  const api = installOmcApi();
  api.on('PUT', '/management/providers/codex-0', () => ({ status: 'ok', family: 'codex', id: 'codex-0' }));
  const view = renderEditor(false, true, false);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Load multi-key draft' }));
    fireEvent.click(screen.getByRole('button', { name: /^Key #1/ }));
    const pool = screen.getAllByRole('group', { name: providerCopy['pool.key_title'] })[0];
    fireEvent.click(within(pool).getByRole('radio', { name: 'On' }));
    fireEvent.change(within(pool).getByRole('spinbutton'), { target: { value: '0' } });
    fireEvent.blur(within(pool).getByRole('spinbutton'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.writes().some(write => write.path === '/management/providers/codex-0')).toBe(true));
    const request = api.writes().find(write => write.path === '/management/providers/codex-0')!.body as Record<string, unknown>;
    const keys = request.keys as Record<string, unknown>[];
    expect(request.connection_pool).toBeUndefined();
    expect(keys[0].connection_pool).toEqual({ enabled: true, max_idle_conns_per_host: 0 });
    expect(keys[1].connection_pool).toBeUndefined();
  } finally { view.unmount(); }
});
