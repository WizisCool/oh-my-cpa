import React from 'react';
import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { OAuthModelRulesDrawer } from '../src/components/authFiles/OAuthModelRulesDrawer';
import { AuthFileDetailDrawer } from '../src/components/authFiles/AuthFileDetailDrawer';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';

const FILE: ManagementAuthFile = { name: 'codex.json', auth_index: 'codex-override', provider: 'codex', type: 'codex', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0 };

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
});

function mountGuidance(section: 'provider' | 'credential') {
  const writes: unknown[] = [];
  const onSaved = vi.fn();
  let fields = { name: FILE.name, excluded_models: ['model-b'], model_aliases: [] };
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    let result: unknown;
    if (url.pathname.endsWith('/auth-files/model-aliases')) result = { aliases: { codex: [{ name: 'model-a', alias: 'public-a' }] } };
    else if (url.pathname.endsWith('/auth-files/excluded-models')) result = { excluded_models: { codex: ['*'] } };
    else if (url.pathname.endsWith('/auth-files/provider-models')) result = { available: true, models: [{ id: 'model-a' }, { id: 'model-b' }] };
    else if (url.pathname.endsWith('/auth-files/safe-fields')) result = fields;
    else if (url.pathname.endsWith('/auth-files/fields')) {
      const body = JSON.parse(options.body as string);
      writes.push(body);
      fields = { ...fields, ...body };
      result = { status: 'ok', file: FILE, fields };
    } else throw new Error(`Unexpected exclusion guidance request: ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const surface = render(<React.StrictMode><App><QueryClientProvider client={client}><I18nProvider>
    {section === 'provider'
      ? <OAuthModelRulesDrawer open providerOptions={['codex']} onClose={() => {}} onSaved={() => {}} />
      : <AuthFileDetailDrawer open file={FILE} canEdit initialSection="overview" onClose={() => {}} onSaved={onSaved} onDownload={() => {}} />}
  </I18nProvider></QueryClientProvider></App></React.StrictMode>);
  return { ...surface, client, writes, onSaved };
}

it('scopes a provider catch-all and alias warning to inheriting credentials, including deletion guidance', async () => {
  const surface = mountGuidance('provider');
  try {
    const drawer = await screen.findByTestId('oauth-model-rules-drawer');
    await waitFor(() => expect(drawer.textContent).toContain('A non-empty credential exclusion list replaces, rather than extends, these defaults.'));
    expect(drawer.textContent).toContain('This precedence requires CPA v8.0.33 or later; upgrade older gateways before relying on credential overrides.');
    const warning = await screen.findByTestId('oauth-model-alias-excluded-source');
    expect(warning.textContent).toContain('Provider rule * hides this source only for credentials inheriting provider exclusions.');
    expect(warning.textContent).toContain('Credentials with a non-empty own list may still serve this alias.');
    fireEvent.click(screen.getByTestId('oauth-model-rules-tab-excluded'));
    expect(await screen.findByText('Provider defaults exclude every model')).toBeTruthy();
    expect(screen.getByTestId('oauth-excluded-models-summary').textContent).toBe('Provider defaults exclude 2 of 2 catalog models');
    expect(await screen.findByText('The rule * matches every model for credentials inheriting provider exclusions; credentials with a non-empty own list use that list instead.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('oauth-model-rules-clear'));
    expect(await screen.findByText('This deletes the provider exclusion defaults for codex. Credentials with a non-empty own list are unchanged; CPA determines which models are available.')).toBeTruthy();
  } finally {
    surface.unmount(); surface.client.clear();
  }
});

it('clears a non-empty credential override with an empty array and explains restored inheritance', async () => {
  const surface = mountGuidance('credential');
  try {
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    const input = await screen.findByLabelText('Excluded Models');
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe('model-b'));
    expect(screen.getByText('Comma or newline separated model IDs. A non-empty list replaces provider exclusions, including *. Clearing this list restores inheritance of the current provider rules, not unrestricted access. This precedence requires CPA v8.0.33 or later; upgrade older gateways before relying on credential overrides.')).toBeTruthy();
    fireEvent.change(input, { target: { value: '' } });
    const save = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(surface.onSaved).toHaveBeenCalledOnce());
    expect(surface.writes).toEqual([{ name: FILE.name, auth_index: FILE.auth_index, excluded_models: [] }]);
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(/Clearing this list restores inheritance of the current provider rules, not unrestricted access\./)).toBeTruthy();
  } finally {
    surface.unmount(); surface.client.clear();
  }
});
