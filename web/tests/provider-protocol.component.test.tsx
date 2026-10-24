import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useT } from '../src/i18n';
import { useState } from 'react';
import { ProviderTable } from '../src/components/providers/ProviderTable';
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
  // The cache is stale on purpose: the server's icon map changed since it was read, and the
  // save must refresh it before migrating ids rather than write the cached copy back.
  const client = createTestQueryClient();
  client.setQueryData(['management-plugins'], { plugins: [] });
  client.setQueryData(['preferences'], { provider_icons: { 'openai-compat-0': 'DeepSeek', 'openai-compat-1': 'Anthropic' } });
  const api = installOmcApi({
    providers: [PROVIDER],
    preferences: { provider_icons: { 'openai-compat-0': 'Anthropic', 'codex-1': 'DeepSeek', 'codex-2': 'DeepSeek' } },
  });
  // A protocol change re-files the provider: one entry per key, under new ids.
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
    expect((writes()[0].body.model_entries as { options: Record<string, unknown> }[])[0].options.use_max_completion_tokens).toBeUndefined();
    expect(writes()[2].body).toEqual({ 'openai-compat-0': 'Anthropic', 'codex-1': 'DeepSeek', 'codex-2': 'DeepSeek' });
    expect(writes()[2].body['openai-compat-1']).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Driver / Protocol' })).toBeNull());
  } finally { view.unmount(); }
});

function ProviderRows({ onEdit }: { onEdit: (provider: ProviderItem) => void }) {
  const t = useT();
  const editor = useProviderManagement({
    t, toast, providerIcons: {}, writeProviderIcon: async () => ({ ok: true }),
    shiftCachedProviderIcons: () => {}, settleProviderRow: () => {},
  });
  return <ProviderTable {...editor} providers={[PROVIDER]} providersLoading={false}
    emptyText="Empty" traffic={new Map()} providerIcons={{}} handleOpenEdit={onEdit} />;
}

it('offers a single editor action for each provider and passes its identity', () => {
  installOmcApi();
  const onEdit = vi.fn();
  const view = renderWithOmc(<ProviderRows onEdit={onEdit} />);
  try {
    const editorActions = screen.getAllByRole('button', { name: /^(Details|Edit): Relay$/ });
    expect(editorActions).toHaveLength(1);
    fireEvent.click(editorActions[0]);
    expect(onEdit.mock.calls).toEqual([[PROVIDER]]);
    expect(screen.getByRole('button', { name: 'Delete: Relay' })).toBeTruthy();
  } finally { view.unmount(); }
});
