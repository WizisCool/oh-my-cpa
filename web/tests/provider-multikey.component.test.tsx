import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ConfigProvider } from 'antd';
import { useT } from '../src/i18n';
import { ProviderEditorDrawer } from '../src/components/providers/ProviderEditorDrawer';
import { useProviderManagement } from '../src/components/providers/useProviderManagement';
import { useProviderIconOverrides } from '../src/components/providers/useProviderIconOverrides';
import type { Toast } from '../src/components/feedback';
import { installOmcApi, json } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';

const toast: Toast = {
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), pending: () => () => {}, dismiss: vi.fn(),
};

// The panel's exit motion is a real timer under jsdom, so the drawer would close a second
// after the click and an assertion would race the animation. The motion is not these
// tests' claim, so the editor renders with it disabled.
const renderEditor = (isCreate: boolean) => {
  const client = createTestQueryClient();
  client.setQueryData(['management-plugins'], { plugins: [] });
  return renderWithOmc(<ConfigProvider theme={{ token: { motion: false } }}><Editor isCreate={isCreate} /></ConfigProvider>, { client });
};

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

it.each([true, false])('saves every Codex key and assigns the selected icon to every returned row (create=%s)', async (isCreate) => {
  const ids = isCreate ? ['codex-2', 'codex-3'] : ['codex-0', 'codex-2'];
  const api = installOmcApi({ preferences: { provider_icons: { 'codex-1': 'Anthropic' } } });
  // Two keys come back as two providers, whichever way the draft was opened.
  api.on('*', /^\/management\/providers(\/codex-0)?$/, request => request.method === 'GET' ? undefined : { status: 'ok', family: 'codex', id: ids[0], ids });
  const writes = () => api.writes() as { path: string; method: string; body: Record<string, unknown> }[];
  const view = renderEditor(isCreate);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Load multi-key draft' }));
    expect(await screen.findByText('Each API key is saved as a separate provider with the same shared settings.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[0].method).toBe(isCreate ? 'POST' : 'PUT');
    expect(writes()[0].body).toMatchObject({ family: 'codex', keys: [
      { api_key: 'fixture-key-one', proxy_url: 'http://proxy-one.test', weight: 3 },
      { api_key: 'fixture-key-two', proxy_url: 'http://proxy-two.test', weight: 7 },
    ] });
    expect(writes()[2].body).toEqual({ 'codex-1': 'Anthropic', [ids[0]]: 'DeepSeek', [ids[1]]: 'DeepSeek' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  } finally { view.unmount(); }
});

it('names a coded refusal in the console language', async () => {
  vi.clearAllMocks();
  const api = installOmcApi();
  api.on('POST', '/management/providers', () => json({ error: 'this provider credential already exists', code: 'provider_credential_exists' }, 409));
  const view = renderEditor(true);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Load multi-key draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    // The facade's English message is only the fallback: the toast must come from
    // the dictionary the rest of the console reads.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This provider credential already exists; change the key or the endpoint'));
  } finally { view.unmount(); }
});
