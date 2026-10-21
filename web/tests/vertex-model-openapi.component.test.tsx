import { useState } from 'react';
import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider, useT } from '../src/i18n';
import { CredentialModelAliasesEditor } from '../src/components/authFiles/CredentialModelAliasesEditor';
import { OAuthModelAliasPanel } from '../src/components/authFiles/OAuthModelAliasPanel';
import { createOAuthModelAliasDrafts, oauthModelAliasDraftsEqual, validateOAuthModelAliasDrafts } from '../src/components/authFiles/oauthModelAliasLogic';
import { ProviderEditorDrawer } from '../src/components/providers/ProviderEditorDrawer';
import { useProviderManagement } from '../src/components/providers/useProviderManagement';
import type { ProviderItem } from '../src/types/providers';
import type { Toast } from '../src/components/feedback';

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }));
});

const ALIASES = [
  { name: 'partner/model', alias: 'first', openapi: false },
  { name: 'partner/model', alias: 'second', openapi: true },
];
function Aliases({ isCredential }: { isCredential: boolean }) {
  const [drafts, setDrafts] = useState(() => createOAuthModelAliasDrafts(ALIASES));
  const result = validateOAuthModelAliasDrafts('vertex', drafts);
  return <>
    {isCredential ? <CredentialModelAliasesEditor aliases={drafts} onChange={setDrafts} isVertex /> :
      <OAuthModelAliasPanel drafts={drafts} onChange={setDrafts} isVertex catalog={[]} catalogState="unavailable" excludedRules={[]} isDisabled={false} />}
    <output data-testid="payload">{JSON.stringify(result.ok ? result.aliases : result)}</output>
  </>;
}

for (const isCredential of [false, true]) {
  it(`preserves explicit false/true in ${isCredential ? 'credential' : 'provider-wide'} alias edits and clears to inheritance`, async () => {
    const view = render(<I18nProvider><Aliases isCredential={isCredential} /></I18nProvider>);
    try {
      const fields = screen.getAllByRole('textbox');
      const displayName = fields.find((field) => field.getAttribute('aria-label')?.startsWith('Display name'));
      expect(displayName).toBeTruthy();
      fireEvent.change(displayName!, { target: { value: 'Edited label' } });
      let payload = JSON.parse(screen.getByTestId('payload').textContent!);
      expect(payload).toEqual([{ ...ALIASES[0], display_name: 'Edited label' }, ALIASES[1]]);
      const control = screen.getAllByRole('combobox').find((input) => input.getAttribute('aria-label')?.startsWith('Model OpenAPI routing'))!;
      fireEvent.mouseDown(control);
      fireEvent.click(await screen.findByText('Inherit', { exact: true }));
      await waitFor(() => {
        payload = JSON.parse(screen.getByTestId('payload').textContent!);
        expect(payload[0].openapi).toBeUndefined();
        expect(payload[1].openapi).toBe(true);
      });
      expect(oauthModelAliasDraftsEqual(createOAuthModelAliasDrafts(ALIASES), createOAuthModelAliasDrafts([{ ...ALIASES[0], openapi: null }, ALIASES[1]]))).toBe(false);
    } finally { view.unmount(); }
  });
}

const PROVIDER: ProviderItem = {
  id: 'vertex-0', family: 'vertex', name: 'Vertex', upstream_name: 'Vertex', protocol: 'Vertex Generate Content',
  disabled: false, key_configured: true, key_entries: [{ index: 0, api_key: 'SYNTHETIC-VERTEX' }],
  behavior: { openapi: 'disabled', openapi_location: 'global', interactions: false },
  model_entries: ALIASES.map((alias) => ({ name: alias.name, alias: alias.alias, options: { openapi: alias.openapi } })),
};
const toast: Toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), pending: () => () => {}, dismiss: vi.fn() };
function Editor() {
  const t = useT();
  const editor = useProviderManagement({ t, toast, providerIcons: {}, writeProviderIcon: async () => ({ ok: true }), shiftCachedProviderIcons: () => {}, settleProviderRow: () => {} });
  return <><button onClick={() => editor.handleOpenEdit(PROVIDER)}>Edit Vertex</button><ProviderEditorDrawer {...editor} familyDisplayNames={{}} /></>;
}

it('saves the real provider editor with credential defaults and alias-specific model overrides intact', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['management-plugins'], { plugins: [] });
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (init?.method === 'PUT' && path.endsWith('/management/providers/vertex-0')) {
      writes.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ status: 'ok', id: 'vertex-0' }), { status: 200 });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  const view = render(<QueryClientProvider client={client}><I18nProvider><App><Editor /></App></I18nProvider></QueryClientProvider>);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Edit Vertex' }));
    await screen.findByRole('combobox', { name: 'Driver / Protocol' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      family: 'vertex', behavior: { openapi: 'disabled', openapi_location: 'global' },
      model_entries: [{ name: 'partner/model', alias: 'first', options: { openapi: false } }, { name: 'partner/model', alias: 'second', options: { openapi: true } }],
    });
  } finally { view.unmount(); client.clear(); }
});
