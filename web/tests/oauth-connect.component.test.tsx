import { CredentialRecoveryPanel } from '../src/components/authFiles/CredentialRecoveryPanel';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import type { OAuthRecoveryTarget } from '../src/types/oauth';
import React from 'react';
import { useLocation } from 'react-router-dom';
import { useT, makeT } from '../src/i18n';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { OAuthConnectPanel } from '../src/pages/oauthManagement/OAuthConnectPanel';
import { OAuthSessionStrip } from '../src/pages/oauthManagement/OAuthSessionStrip';
import { useOAuthSessions } from '../src/pages/oauthManagement/useOAuthSessions';
import { pluginOAuthProviderChoices, type OAuthProviderChoice } from '../src/pages/oauthProviderLogic';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';

const CHOICES: OAuthProviderChoice[] = ['codex', 'anthropic'].map(id => ({
  id, title: id, description: '', iconId: '', flow: 'manual-callback', group: 'builtin', loginLabel: id,
}));

function ConnectWorkspace({ choices = CHOICES, recovery, isRecoverySupported = true }: { choices?: OAuthProviderChoice[]; recovery?: OAuthRecoveryTarget; isRecoverySupported?: boolean } = {}) {
  const [isOpen, setIsOpen] = React.useState(true);
  const [providerId, setProviderId] = React.useState(choices[0].id);
  const location = useLocation();
  const sessions = useOAuthSessions(choices);
  return <>
    <button data-testid="minimize" onClick={() => setIsOpen(false)} />
    <button data-testid="reopen" onClick={() => setIsOpen(true)} />
    <button data-testid="other-provider" onClick={() => setProviderId(current => choices.find(choice => choice.id !== current)?.id ?? current)} />
    <output data-testid="sessions">{JSON.stringify(sessions.states)}</output>
    <output data-testid="location">{location.pathname}</output>
    <OAuthConnectPanel recoveryTarget={recovery} isRecoverySupported={isRecoverySupported} open={isOpen} choices={choices} selectedProviderId={providerId}
      onSelectProvider={setProviderId} onClose={() => setIsOpen(false)} onViewCredentials={() => {}} sessions={sessions} />
  </>;
}

function PluginConnectWorkspace() {
  const choices = pluginOAuthProviderChoices([{
    id: 'workbuddy', configured: true, registered: true, enabled: true, effective_enabled: true,
    supports_oauth: true, oauth_provider: 'workbuddy', config_fields: [],
    pages: [{ path: '/v0/resource/plugins/workbuddy/panel', label: 'Accounts' }],
  }], useT());
  return <ConnectWorkspace choices={choices} />;
}

it('logs in from a plugin with a management page, completes polling and keeps navigation separate', async () => {
  vi.useFakeTimers();
  const server = installOmcApi();
  let shouldFail = false;
  server.on('POST', '/management/oauth/start', () => shouldFail
    ? json({ code: 'cpa_rejected_request', error: 'Plugin login unavailable' }, 400)
    : { url: 'https://auth.example.test/workbuddy', state: 'workbuddy-login' });
  server.on('GET', '/management/oauth/status', () => ({ status: 'ok' }));
  const surface = renderWithOmc(<PluginConnectWorkspace />, { route: '/omc/oauth-management', isStrict: true });
  const start = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start="workbuddy"]');
  const pluginPage = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-plugin-connect="workbuddy"]');
  const callback = () => surface.baseElement.querySelector('[data-oauth-callback-input]');
  const session = () => JSON.parse(screen.getByTestId('sessions').textContent!).workbuddy;
  try {
    expect(pluginPage()).toBeTruthy();
    expect(callback()).toBeNull();
    await act(async () => { fireEvent.click(pluginPage()!); });
    expect(screen.getByTestId('location').textContent).toBe('/plugin-pages/workbuddy/0');
    expect(server.writes('/management/oauth/start')).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByTestId('reopen')); });
    await act(async () => { fireEvent.click(start()!); });
    expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([{ provider: 'workbuddy' }]);
    expect(session().status).toBe('waiting');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(session().status).toBe('success');

    const failureReason = 'no active GLM Coding Plan or ZCode gift plan';
    server.on('GET', '/management/oauth/status', () => ({ status: 'error', message: failureReason }));
    await act(async () => { fireEvent.click(start()!); });
    expect(session().status).toBe('waiting');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(session()).toMatchObject({ status: 'error', polling: false, error: failureReason });
    expect(surface.baseElement.textContent).toContain(failureReason);

    shouldFail = true;
    await act(async () => { fireEvent.click(start()!); });
    expect(session().status).toBe('error');
    expect(surface.baseElement.textContent).toContain('Plugin login unavailable');
  } finally {
    surface.unmount();
    vi.useRealTimers();
  }
});

it('submits an ephemeral proxy once and keeps provider sessions independent across minimizing', async () => {
  const proxyURL = 'http://operator:proxy-pass@proxy.example.test:8080';
  const server = installOmcApi();
  server.on('POST', '/management/oauth/start', request => ({ url: 'https://auth.example.test/authorize', state: (request.body as { provider: string }).provider }));
  server.on('GET', '/management/oauth/status', () => ({ status: 'wait' }));
  const surface = renderWithOmc(<ConnectWorkspace />, { route: '/omc/oauth-management', isStrict: true });
  const input = () => surface.baseElement.querySelector<HTMLInputElement>('#oauth-connect-proxy')!;
  const start = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start]')!;
  try {
    await waitFor(() => expect(input()).toBeTruthy());
    fireEvent.change(input(), { target: { value: proxyURL } });
    fireEvent.click(screen.getByTestId('other-provider'));
    await waitFor(() => expect(input().value).toBe(''));
    fireEvent.change(input(), { target: { value: proxyURL } });
    fireEvent.click(start());
    await waitFor(() => expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([{ provider: 'anthropic', proxy_url: proxyURL }]));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('sessions').textContent!).anthropic.status).toBe('waiting'));
    fireEvent.click(screen.getByTestId('minimize'));
    fireEvent.click(screen.getByTestId('other-provider'));
    fireEvent.click(screen.getByTestId('reopen'));
    await waitFor(() => expect(input().value).toBe(''));
    fireEvent.click(start());
    await waitFor(() => expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([{ provider: 'anthropic', proxy_url: proxyURL }, { provider: 'codex' }]));
    expect(screen.getByTestId('sessions').textContent).not.toContain(proxyURL);
    expect(JSON.stringify(server.state.preferences)).not.toContain(proxyURL);
  } finally { surface.unmount(); }
});

it('keeps targeted recovery pinned across failure/minimizing and verifies credential only after confirmation', async () => {
  const server = installOmcApi();
  let shouldSucceed = false;
  server.on('POST', '/management/oauth/start', () => shouldSucceed
    ? { url: 'https://auth.example.test/authorize', state: 'targeted-state' }
    : json({ code: 'oauth_recovery_upgrade_required', error: 'upgrade required' }, 501));
  server.on('GET', '/management/oauth/status', () => ({ status: 'wait' }));
  server.on('POST', '/management/auth-files/verify', () => ({ status: 'ok', verified: true }));
  const recovery = { name: 'same-account.json', auth_index: 'account-index' };
  const changed = vi.fn();
  const file: ManagementAuthFile = {
    name: 'selected.json', auth_index: 'selected', provider: 'codex', disabled: false, unavailable: false, runtime_only: false,
    success: 0, failed: 0, recovery_supported: true, requires_sign_in: false, renewal_state: 'awaiting_first_renewal',
    recovery_stage: 'loaded', adopted: true, inference_verified: false, renewal_verified: false,
  };
  const surface = renderWithOmc(<>
    <ConnectWorkspace recovery={recovery} />
    <CredentialRecoveryPanel file={file} canEdit onChanged={changed} />
  </>, { route: '/omc/oauth-management' });
  const start = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start]')!;
  const verification = () => screen.getByRole('checkbox', { name: /Verify inference after sign-in/ });
  try {
    expect((verification() as HTMLInputElement).checked).toBe(false);
    fireEvent.click(start());
    await waitFor(() => {
      expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([{ provider: 'codex', ...recovery, verify: false }]);
      expect((verification() as HTMLInputElement).disabled).toBe(false);
    });
    shouldSucceed = true;
    fireEvent.click(verification());
    fireEvent.click(start());
    await waitFor(() => expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([
      { provider: 'codex', ...recovery, verify: false }, { provider: 'codex', ...recovery, verify: true },
    ]));

    fireEvent.click(screen.getByTestId('minimize'));
    fireEvent.click(surface.baseElement.querySelector('[data-credential-verify]')!);
    const confirmation = await screen.findByRole('dialog');
    await act(async () => { fireEvent.click(within(confirmation).getByRole('button', { name: 'Verify inference (uses tokens)' })); });
    await waitFor(() => expect(server.writes('/management/auth-files/verify').map(request => request.body)).toEqual([{ name: 'selected.json', auth_index: 'selected' }]));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  } finally { surface.unmount(); }
});

/**
 * The drawer is not the only place an attempt exists: a session outlives it, so the strip
 * beside the page is where a closed panel's sign-in is answered.
 */
function SessionWorkspace() {
  const sessions = useOAuthSessions(CHOICES);
  return <>
    <button data-testid="start" onClick={() => void sessions.start('codex')} />
    <output data-testid="sessions">{JSON.stringify(sessions.states)}</output>
    <OAuthSessionStrip sessions={sessions} choices={CHOICES} onOpen={() => {}} />
  </>;
}

it('cancels a waiting sign-in from outside the collapsed drawer', async () => {
  const server = installOmcApi();
  server.on('POST', '/management/oauth/start', () => ({ url: 'https://auth.example.test/authorize', state: 'codex-login' }));
  server.on('GET', '/management/oauth/status', () => ({ status: 'wait' }));
  server.on('DELETE', '/management/oauth/session', () => ({ status: 'ok', cancelled: true }));
  const surface = renderWithOmc(<SessionWorkspace />, { route: '/omc/oauth-management' });
  const session = () => JSON.parse(screen.getByTestId('sessions').textContent!).codex;
  try {
    fireEvent.click(screen.getByTestId('start'));
    await waitFor(() => expect(session().status).toBe('waiting'));
    expect(screen.getByTestId('oauth-session-pill')).toBeTruthy();

    await act(async () => { fireEvent.click(surface.baseElement.querySelector('[data-oauth-cancel="codex"]')!); });
    await waitFor(() => expect(server.writes('/management/oauth/session').map(request => request.method)).toEqual(['DELETE']));
    await waitFor(() => expect(session().status).toBe('idle'));
    expect(screen.queryByTestId('oauth-session-pill')).toBeNull();
  } finally { surface.unmount(); }
});

it('keeps a refused cancellation waiting and says so', async () => {
  const server = installOmcApi();
  server.on('POST', '/management/oauth/start', () => ({ url: 'https://auth.example.test/authorize', state: 'codex-login' }));
  server.on('GET', '/management/oauth/status', () => ({ status: 'wait' }));
  // CPA answers that the session is already past cancelling, so a false "cancelled" would
  // hide a sign-in that may still save a credential.
  server.on('DELETE', '/management/oauth/session', () => ({ status: 'ok', cancelled: false }));
  const surface = renderWithOmc(<SessionWorkspace />, { route: '/omc/oauth-management' });
  const session = () => JSON.parse(screen.getByTestId('sessions').textContent!).codex;
  try {
    fireEvent.click(screen.getByTestId('start'));
    await waitFor(() => expect(session().status).toBe('waiting'));
    await act(async () => { fireEvent.click(surface.baseElement.querySelector('[data-oauth-cancel="codex"]')!); });
    await waitFor(() => expect(screen.getByText(makeT('en')('oauth.cancel_refused'))).toBeTruthy());
    expect(session().status).toBe('waiting');
    expect(screen.getByTestId('oauth-session-pill')).toBeTruthy();
  } finally { surface.unmount(); }
});
