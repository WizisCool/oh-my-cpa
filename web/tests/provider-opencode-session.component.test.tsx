import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, useT } from '../src/i18n';
import { ProviderEditorDrawer } from '../src/components/providers/ProviderEditorDrawer';
import { useProviderManagement } from '../src/components/providers/useProviderManagement';
import { useProviderIconOverrides } from '../src/components/providers/useProviderIconOverrides';
import type { Toast } from '../src/components/feedback';
import type { ProviderItem } from '../src/types/providers';

const OPENCODE_PROVIDER: ProviderItem = {
  id: 'openai-compat-0', family: 'openai-compatibility', name: 'OpenCode Go', upstream_name: 'opencode-go',
  protocol: 'OpenAI Compatible', base_url: 'https://opencode.ai/zen/go/v1',
  disabled: false, key_configured: true,
  key_entries: [{ index: 0, api_key: 'fixture-key', weight: 1 }],
  model_entries: [{ name: 'glm-5.2' }],
};
const RELAY_PROVIDER: ProviderItem = {
  ...OPENCODE_PROVIDER, name: 'Relay', upstream_name: 'relay', base_url: 'https://relay.example.test/v1',
};
const toast: Toast = {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), pending: () => () => {}, dismiss: vi.fn(),
};

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  }));
});

/** The real drawer and hook; `writeProviderIcon` records the preference write the save path makes. */
function Editor({ provider }: { provider: ProviderItem }) {
  const t = useT();
  const icons = useProviderIconOverrides();
  const editor = useProviderManagement({ ...icons, t, toast, settleProviderRow: () => {} });
  return <>
    <button onClick={() => editor.handleOpenEdit(provider)}>Edit fixture</button>
    <ProviderEditorDrawer {...editor} familyDisplayNames={{}} />
  </>;
}

function renderEditor(provider: ProviderItem) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (init?.method === 'PUT' || init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (path.endsWith('/management/providers/openai-compat-0')) {
        return new Response(JSON.stringify({ status: 'ok', id: 'openai-compat-0', ids: ['openai-compat-0'] }), { status: 200 });
      }
      if (path.endsWith('/preferences/provider_icons')) return new Response('{}', { status: 200 });
    }
    if (path.endsWith('/preferences')) {
      return new Response(JSON.stringify({ preferences: {} }), { status: 200 });
    }
    if (path.endsWith('/management/plugins')) return new Response(JSON.stringify({ plugins: [] }), { status: 200 });
    throw new Error(`Unexpected fixture request ${init?.method ?? 'GET'} ${path}`);
  }));
  const view = render(
    <QueryClientProvider client={client}>
      <I18nProvider><AntdApp><Editor provider={provider} /></AntdApp></I18nProvider>
    </QueryClientProvider>,
  );
  const openEditor = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit fixture' }));
    await screen.findByRole('combobox', { name: 'Driver / Protocol' });
  };
  return { client, writes, view, openEditor };
}

it('offers the OpenCode session header once, and the save carries the exact pair', async () => {
  const { client, writes, view, openEditor } = renderEditor(OPENCODE_PROVIDER);
  try {
    await openEditor();
    expect(await screen.findByText('This OpenCode endpoint needs a session header')).toBeTruthy();
    // The requirement has to name the header it adds, because the collapsed
    // Custom Headers group is where the row is about to appear.
    expect(screen.getByText(/OpenCode identifies a conversation by x-opencode-session/)).toBeTruthy();
    expect(screen.getByText(/CPA expands \$CPA-SESSION-ID into the session identifier of this request/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add x-opencode-session' }));
    await waitFor(() => expect(screen.queryByText('This OpenCode endpoint needs a session header')).toBeNull());
    expect((screen.getByDisplayValue('x-opencode-session') as HTMLInputElement).value).toBe('x-opencode-session');
    expect((screen.getByDisplayValue('$CPA-SESSION-ID') as HTMLInputElement).value).toBe('$CPA-SESSION-ID');
    // The click only edits the draft: nothing is written until the operator saves.
    expect(writes).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes.some((write) => write.path.endsWith('/management/providers/openai-compat-0'))).toBe(true));
    const save = writes.find((write) => write.path.endsWith('/management/providers/openai-compat-0'));
    expect(save?.body.headers).toEqual({ 'x-opencode-session': '$CPA-SESSION-ID' });
  } finally { view.unmount(); client.clear(); }
});

it('follows the endpoint in the draft rather than the provider it was opened from', async () => {
  const { client, view, openEditor } = renderEditor(RELAY_PROVIDER);
  try {
    await openEditor();
    expect(screen.queryByText('This OpenCode endpoint needs a session header')).toBeNull();
    const baseURL = screen.getByPlaceholderText('e.g. https://api.deepseek.com/v1');

    fireEvent.change(baseURL, { target: { value: 'https://opencode.ai/zen/v1' } });
    expect(await screen.findByText('This OpenCode endpoint needs a session header')).toBeTruthy();

    // A lookalike host or a path that merely spells opencode.ai is not OpenCode.
    fireEvent.change(baseURL, { target: { value: 'https://relay.example/opencode.ai/zen/v1' } });
    await waitFor(() => expect(screen.queryByText('This OpenCode endpoint needs a session header')).toBeNull());
  } finally { view.unmount(); client.clear(); }
});

it('leaves a provider that already maps its own session id quiet', async () => {
  const { client, view, openEditor } = renderEditor({
    ...OPENCODE_PROVIDER,
    headers: { 'X-OpenCode-Session': 'ses_operator_choice' },
  });
  try {
    await openEditor();
    // The draft already names a session id, so the guidance would be
    // describing a header that is present.
    expect(screen.queryByText('This OpenCode endpoint needs a session header')).toBeNull();
  } finally { view.unmount(); client.clear(); }
});
