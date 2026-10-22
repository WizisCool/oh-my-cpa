import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { OAuthModelRulesDrawer } from '../src/components/authFiles/OAuthModelRulesDrawer';
import { AuthFileDetailDrawer } from '../src/components/authFiles/AuthFileDetailDrawer';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

const FILE: ManagementAuthFile = { name: 'codex.json', auth_index: 'codex-override', provider: 'codex', type: 'codex', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0 };

function mountGuidance(section: 'provider' | 'credential') {
  const onSaved = vi.fn();
  const api = installOmcApi({ authFiles: [{ file: FILE, fields: { excluded_models: ['model-b'], model_aliases: [] } }] });
  // The provider-wide rules every credential of the family inherits.
  api.on('GET', '/management/auth-files/model-aliases', () => ({ aliases: { codex: [{ name: 'model-a', alias: 'public-a' }] } }));
  api.on('GET', '/management/auth-files/excluded-models', () => ({ excluded_models: { codex: ['*'] } }));
  api.on('GET', '/management/auth-files/provider-models', () => ({ available: true, models: [{ id: 'model-a' }, { id: 'model-b' }] }));
  const surface = renderWithOmc(section === 'provider'
    ? <OAuthModelRulesDrawer open providerOptions={['codex']} onClose={() => {}} onSaved={() => {}} />
    : <AuthFileDetailDrawer open file={FILE} canEdit initialSection="overview" onClose={() => {}} onSaved={onSaved} onDownload={() => {}} />, { isStrict: true });
  return { ...surface, onSaved, get writes() { return api.writes('/management/auth-files/fields').map(request => request.body); } };
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
    surface.unmount();
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
    surface.unmount();
  }
});
