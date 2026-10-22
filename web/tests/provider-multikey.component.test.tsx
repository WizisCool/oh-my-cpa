import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App as AntdApp, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, useT } from '../src/i18n';
import { ProviderEditorDrawer } from '../src/components/providers/ProviderEditorDrawer';
import { useProviderManagement } from '../src/components/providers/useProviderManagement';
import { useProviderIconOverrides } from '../src/components/providers/useProviderIconOverrides';
import type { Toast } from '../src/components/feedback';

const toast: Toast = {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), pending: () => () => {}, dismiss: vi.fn(),
};

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }));
});

function Editor({ isCreate }: { isCreate: boolean }) {
  const t = useT();
  const icons = useProviderIconOverrides();
  const editor = useProviderManagement({ ...icons, t, toast, settleProviderRow: () => {} });
  return <>
    <button onClick={() => {
      if (isCreate) editor.handleOpenCreate();
      else editor.handleOpenEdit({ id: 'codex-0', family: 'codex', name: 'Relay', protocol: 'OpenAI Responses', base_url: 'https://relay.test', disabled: false, key_configured: true, auth_index: 'fixture-index' });
      editor.setFormFamily('codex');
      editor.setFormName('Relay');
      editor.setFormBaseURL('https://relay.test');
      editor.setFormIcon('DeepSeek');
      editor.setFormKeys([
        { id: 'first', apiKey: 'fixture-key-one', proxyUrl: 'http://proxy-one.test', weight: 3, isChanging: true },
        { id: 'second', apiKey: 'fixture-key-two', proxyUrl: 'http://proxy-two.test', weight: 7, isChanging: true },
      ]);
    }}>Load multi-key draft</button>
    <ProviderEditorDrawer {...editor} familyDisplayNames={{}} />
  </>;
}

// The panel's exit motion is a real timer under jsdom, so the drawer would close
// a second after the click and the assertion below would race the animation. The
// motion itself is not this test's claim, so the provider tree disables it.
it.each([true, false])('saves every Codex key and assigns the selected icon to every returned row (create=%s)', async (isCreate) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['management-plugins'], { plugins: [] });
  client.setQueryData(['preferences'], { provider_icons: { 'codex-1': 'Anthropic' } });
  const ids = isCreate ? ['codex-2', 'codex-3'] : ['codex-0', 'codex-2'];
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (init?.method === 'POST' || init?.method === 'PUT') {
      writes.push({ path, method: init.method, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (path.includes('/management/providers')) return new Response(JSON.stringify({ status: 'ok', family: 'codex', id: ids[0], ids }), { status: 200 });
      if (path.endsWith('/preferences/provider_icons')) return new Response('{}', { status: 200 });
    }
    throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
  }));
  const view = render(<QueryClientProvider client={client}><I18nProvider><ConfigProvider theme={{ token: { motion: false } }}><AntdApp><Editor isCreate={isCreate} /></AntdApp></ConfigProvider></I18nProvider></QueryClientProvider>);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Load multi-key draft' }));
    expect(await screen.findByText('Each API key is saved as a separate provider with the same shared settings.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[0].method).toBe(isCreate ? 'POST' : 'PUT');
    expect(writes[0].body).toMatchObject({ family: 'codex', keys: [
      { api_key: 'fixture-key-one', proxy_url: 'http://proxy-one.test', weight: 3 },
      { api_key: 'fixture-key-two', proxy_url: 'http://proxy-two.test', weight: 7 },
    ] });
    expect(writes[2].body).toEqual({ 'codex-1': 'Anthropic', [ids[0]]: 'DeepSeek', [ids[1]]: 'DeepSeek' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  } finally { view.unmount(); client.clear(); }
});

it('names a coded refusal in the console language', async () => {
  vi.clearAllMocks();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['management-plugins'], { plugins: [] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ error: 'this provider credential already exists', code: 'provider_credential_exists' }),
    { status: 409 },
  )));
  const view = render(<QueryClientProvider client={client}><I18nProvider><ConfigProvider theme={{ token: { motion: false } }}><AntdApp><Editor isCreate={true} /></AntdApp></ConfigProvider></I18nProvider></QueryClientProvider>);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Load multi-key draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    // The facade's English message is only the fallback: the toast must come from
    // the dictionary the rest of the console reads.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This provider credential already exists; change the key or the endpoint'));
  } finally { view.unmount(); client.clear(); }
});
