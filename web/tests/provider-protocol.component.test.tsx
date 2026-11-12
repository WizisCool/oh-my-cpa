import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useT } from '../src/i18n';
import { useState } from 'react';
import { ProviderEditorDrawer } from '../src/components/providers/ProviderEditorDrawer';
import { useProviderManagement } from '../src/components/providers/useProviderManagement';
import { useProviderIconOverrides } from '../src/components/providers/useProviderIconOverrides';
import type { Toast } from '../src/components/feedback';
import type { ProviderItem } from '../src/types/providers';
import { installOmcApi } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';

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
  const api = installOmcApi();
  api.on('POST', '/management/providers/probe', () => ({ ok: true }));
  api.on('POST', '/management/providers/pull-models', () => ({ models: ['model-one'] }));
  const requests = () => api.writes().map(request => request.body as Record<string, unknown>);
  const view = renderWithOmc(<DraftProbes />);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Load draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Messages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Probe draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pull draft models' }));
    await waitFor(() => expect(requests()).toHaveLength(3));
    for (const request of requests()) {
      expect(request.family).toBe('claude');
      expect(request.provider_id).toBeUndefined();
      expect(request.base_url).toBe(PROVIDER.base_url);
    }
    expect(requests().slice(0, 2).map(request => request.api_key)).toEqual(['fixture-key-one', 'fixture-key-two']);
  } finally { view.unmount(); }
});

function TestModelDraft() {
  const t = useT();
  const editor = useProviderManagement({ t, toast, providerIcons: {}, writeProviderIcon: async () => ({ ok: true }), shiftCachedProviderIcons: () => {}, settleProviderRow: () => {} });
  const provider = { ...PROVIDER, test_model: 'model-two', model_entries: [{ name: 'model-one' }, { name: 'model-two' }, { name: 'auto' }] };
  return <>
    <button onClick={() => editor.handleOpenEdit(provider)}>Open test model</button>
    <button onClick={() => editor.setFormTestModel('model-one')}>Select first model</button>
    <button onClick={() => editor.setFormTestModel('auto')}>Select model named auto</button>
    <button onClick={() => editor.setFormTestModel('')}>Select automatic</button>
    <button onClick={editor.handleSaveProvider}>Save test model</button>
    <button onClick={() => { void editor.handleTestAllKeys(); }}>Test selected model</button>
    <output>{editor.formTestModel}</output>
  </>;
}

it('restores, probes and saves the chosen test model', async () => {
  const api = installOmcApi({ providers: [PROVIDER] });
  api.on('POST', '/management/providers/probe', () => ({ ok: true }));
  const view = renderWithOmc(<TestModelDraft />);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Open test model' }));
    expect(screen.getByText('model-two')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test selected model' }));
    await waitFor(() => expect(api.writes().filter(request => request.path.endsWith('/probe'))).toHaveLength(2));
    expect((api.writes()[0].body as Record<string, unknown>).model).toBe('model-two');
    fireEvent.click(screen.getByRole('button', { name: 'Select first model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save test model' }));
    await waitFor(() => expect(api.writes().some(request => request.method === 'PUT' && request.path.endsWith('/management/providers/openai-compat-0'))).toBe(true));
    const saved = api.writes().find(request => request.method === 'PUT' && request.path.endsWith('/management/providers/openai-compat-0'));
    expect((saved?.body as Record<string, unknown>).test_model).toBe('model-one');
  } finally { view.unmount(); }
});

it('distinguishes automatic from a configured model named auto', async () => {
  const api = installOmcApi({ providers: [PROVIDER] });
  api.on('POST', '/management/providers/probe', () => ({ ok: true }));
  const view = renderWithOmc(<TestModelDraft />);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Open test model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select model named auto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test selected model' }));
    await waitFor(() => expect(api.writes().filter(request => request.path.endsWith('/probe'))).toHaveLength(2));
    expect((api.writes()[0].body as Record<string, unknown>).model).toBe('auto');
    fireEvent.click(screen.getByRole('button', { name: 'Save test model' }));
    await waitFor(() => expect(api.writes().some(request => request.method === 'PUT' && request.path.endsWith('/management/providers/openai-compat-0'))).toBe(true));
    expect((api.writes().find(request => request.method === 'PUT' && request.path.endsWith('/management/providers/openai-compat-0'))?.body as Record<string, unknown>).test_model).toBe('auto');
    fireEvent.click(screen.getByRole('button', { name: 'Select automatic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test selected model' }));
    await waitFor(() => expect(api.writes().filter(request => request.path.endsWith('/probe'))).toHaveLength(4));
    expect((api.writes().filter(request => request.path.endsWith('/probe'))[2].body as Record<string, unknown>).model).toBe('model-one');
  } finally { view.unmount(); }
});

it('keeps probe failures readable until dismissed', async () => {
  const api = installOmcApi({ providers: [PROVIDER] });
  const reason = `upstream answered 401: ${'long error '.repeat(40)}end`;
  api.on('POST', '/management/providers/probe', () => ({ ok: false, error: reason }));
  vi.mocked(toast.error).mockClear();
  const view = renderWithOmc(<TestModelDraft />);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Open test model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test selected model' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Connectivity test failed', { detail: reason, isPersistent: true }));
  } finally { view.unmount(); }
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
  const client = createTestQueryClient();
  client.setQueryData(['management-plugins'], { plugins: [] });
  client.setQueryData(['preferences'], { provider_icons: { 'openai-compat-0': 'DeepSeek', 'openai-compat-1': 'Anthropic' } });
  const api = installOmcApi({
    providers: [PROVIDER],
    preferences: { provider_icons: { 'openai-compat-0': 'Anthropic', 'codex-1': 'DeepSeek', 'codex-2': 'DeepSeek' } },
  });
  api.on('PUT', '/management/providers/openai-compat-0', () => ({ status: 'ok', id: 'codex-1', ids: ['codex-1', 'codex-2'] }));
  const writes = () => api.writes() as { path: string; body: Record<string, unknown> }[];
  const view = renderWithOmc(<Editor />, { client });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Edit fixture' }));
    const protocol = await screen.findByRole('combobox', { name: 'Driver / Protocol' });
    expect((protocol as HTMLInputElement).disabled).toBe(false);
    fireEvent.mouseDown(protocol);
    fireEvent.click(await screen.findByText('Codex (Response) (codex)'));
    expect(await screen.findByText(/Saving creates a separate provider for each key/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[0].path).toMatch(/\/management\/providers\/openai-compat-0$/);
    expect(writes()[0].body).toMatchObject({
      family: 'codex', expected_name: 'relay', name: 'Relay', base_url: PROVIDER.base_url, website: PROVIDER.website,
      keys: [{ api_key: 'fixture-key-one', weight: 3 }, { api_key: 'fixture-key-two', weight: 4 }],
      model_entries: [{ name: 'model-one', alias: 'one', image: false, options: { max_context_length: 32000 } }],
    });
    expect(writes()[2].body).toEqual({ 'openai-compat-0': 'Anthropic', 'codex-1': 'DeepSeek', 'codex-2': 'DeepSeek' });
  } finally { view.unmount(); }
});
