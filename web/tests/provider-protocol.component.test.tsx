import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, useT } from '../src/i18n';
import { useState } from 'react';
import { ProviderEditorDrawer } from '../src/components/providers/ProviderEditorDrawer';
import { useProviderManagement } from '../src/components/providers/useProviderManagement';
import { useProviderIconOverrides } from '../src/components/providers/useProviderIconOverrides';
import type { Toast } from '../src/components/feedback';
import type { ProviderItem } from '../src/types/providers';

const PROVIDER: ProviderItem = {
  id: 'openai-compat-0', family: 'openai-compatibility', name: 'Relay', upstream_name: 'relay',
  protocol: 'OpenAI Compatible', base_url: 'https://relay.example.test/v1', website: 'https://relay.example.test',
  disabled: false, key_configured: true,
  key_entries: [{ index: 0, api_key: 'fixture-key-one', weight: 3 }, { index: 1, api_key: 'fixture-key-two', weight: 4 }],
  model_entries: [{ name: 'model-one', alias: 'one', image: true, options: { max_context_length: 32000, use_max_completion_tokens: true } }],
};
const toast: Toast = {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), pending: () => () => {}, dismiss: vi.fn(),
};

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }));
});

function DraftProbes() {
  const t = useT();
  const [hasOpened, setHasOpened] = useState(false);
  const editor = useProviderManagement({
    t, toast, providerIcons: {}, writeProviderIcon: async () => ({ ok: true }),
    shiftCachedProviderIcons: () => {}, settleProviderRow: () => {},
  });
  return <>
    <button onClick={() => { editor.handleOpenEdit(PROVIDER); setHasOpened(true); }}>Load draft</button>
    {hasOpened && <>
      <button onClick={() => editor.setFormFamily('claude')}>Switch to Messages</button>
      <button onClick={() => { void editor.handleTestAllKeys(); }}>Probe draft</button>
      <button onClick={() => { void editor.handlePullModels(); }}>Pull draft models</button>
    </>}
  </>;
}

it('uses the selected draft protocol for probes and model pulls without resolving the old provider id', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, models: ['model-one'] }), { status: 200 });
  }));
  const view = render(<QueryClientProvider client={client}><I18nProvider><DraftProbes /></I18nProvider></QueryClientProvider>);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Load draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Messages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Probe draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pull draft models' }));
    await waitFor(() => expect(requests).toHaveLength(3));
    for (const request of requests) {
      expect(request.family).toBe('claude');
      expect(request.provider_id).toBeUndefined();
      expect(request.base_url).toBe(PROVIDER.base_url);
    }
    expect(requests.slice(0, 2).map(request => request.api_key)).toEqual(['fixture-key-one', 'fixture-key-two']);
  } finally { view.unmount(); client.clear(); }
});

function Editor() {
  const t = useT();
  const icons = useProviderIconOverrides();
  const editor = useProviderManagement({ ...icons, t, toast, settleProviderRow: () => {} });
  return <>
    <button onClick={() => editor.handleOpenEdit(PROVIDER)}>Edit fixture</button>
    <ProviderEditorDrawer {...editor} familyDisplayNames={{}} />
  </>;
}

it('saves a changed protocol with the original identity and refreshes migrated icons before writing them', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['management-plugins'], { plugins: [] });
  client.setQueryData(['preferences'], { provider_icons: { 'openai-compat-0': 'DeepSeek', 'openai-compat-1': 'Anthropic' } });
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (init?.method === 'PUT') {
      writes.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (path.endsWith('/management/providers/openai-compat-0')) {
        return new Response(JSON.stringify({ status: 'ok', id: 'codex-1', ids: ['codex-1', 'codex-2'] }), { status: 200 });
      }
      if (path.endsWith('/preferences/provider_icons')) return new Response('{}', { status: 200 });
    }
    if (path.endsWith('/preferences')) {
      return new Response(JSON.stringify({ preferences: { provider_icons: { 'openai-compat-0': 'Anthropic', 'codex-1': 'DeepSeek', 'codex-2': 'DeepSeek' } } }), { status: 200 });
    }
    throw new Error(`Unexpected fixture request ${init?.method ?? 'GET'} ${path}`);
  }));
  const view = render(<QueryClientProvider client={client}><I18nProvider><AntdApp><Editor /></AntdApp></I18nProvider></QueryClientProvider>);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Edit fixture' }));
    const protocol = await screen.findByRole('combobox', { name: 'Driver / Protocol' });
    expect((protocol as HTMLInputElement).disabled).toBe(false);
    fireEvent.mouseDown(protocol);
    fireEvent.click(await screen.findByText('Codex (Response) (codex)'));
    expect(await screen.findByText(/Saving creates a separate provider for each key/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[0].path).toMatch(/\/management\/providers\/openai-compat-0$/);
    expect(writes[0].body).toMatchObject({
      family: 'codex', expected_name: 'relay', name: 'Relay', base_url: PROVIDER.base_url, website: PROVIDER.website,
      keys: [{ api_key: 'fixture-key-one', weight: 3 }, { api_key: 'fixture-key-two', weight: 4 }],
      model_entries: [{ name: 'model-one', alias: 'one', image: false, options: { max_context_length: 32000 } }],
    });
    expect((writes[0].body.model_entries as { options: Record<string, unknown> }[])[0].options.use_max_completion_tokens).toBeUndefined();
    expect(writes[2].body).toEqual({ 'openai-compat-0': 'Anthropic', 'codex-1': 'DeepSeek', 'codex-2': 'DeepSeek' });
    expect(writes[2].body['openai-compat-1']).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Driver / Protocol' })).toBeNull());
  } finally { view.unmount(); client.clear(); }
});
