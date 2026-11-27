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
import { builtinOAuthProviderChoices, pluginOAuthProviderChoices, type OAuthProviderChoice } from '../src/pages/oauthProviderLogic';
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
    expect(verification().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(start());
    await waitFor(() => {
      expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([{ provider: 'codex', ...recovery, verify: false }]);
      expect(verification().getAttribute('aria-disabled')).not.toBe('true');
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

it('surfaces 409 verification_not_applied as its own warning state on the recovery panel', async () => {
  const t = makeT('en');
  const server = installOmcApi();
  let mode: 'not_applied' | 'verified' | 'deferred_not_applied' | 'sandbox_reset' = 'not_applied';
  let releaseDeferred!: () => void;
  server.on('POST', '/management/auth-files/verify', async () => {
    if (mode === 'deferred_not_applied') {
      await new Promise<void>((resolve) => { releaseDeferred = resolve; });
      return json({ code: 'verification_not_applied', error: 'still cooling' }, 409);
    }
    if (mode === 'sandbox_reset') {
      return json({ code: 'sandbox_reset', error: 'Sandbox was reset during verification' }, 409);
    }
    return mode === 'not_applied'
      ? json({ code: 'verification_not_applied', error: 'verification inference completed, but CPA did not apply it' }, 409)
      : { status: 'ok', verified: true };
  });
  const changed = vi.fn();
  const file: ManagementAuthFile = {
    name: 'cooling.json', auth_index: 'cooling-idx', provider: 'claude', disabled: false, unavailable: true, runtime_only: false,
    success: 0, failed: 1, recovery_supported: true, requires_sign_in: false, renewal_state: 'awaiting_first_renewal',
    recovery_stage: 'quota_blocked', adopted: true, inference_verified: false, renewal_verified: false,
  };
  const siblingFile: ManagementAuthFile = { ...file, name: 'sibling.json', auth_index: 'sibling-idx' };
  let setActiveFile!: (next: ManagementAuthFile) => void;
  function RecoveryHarness() {
    const [activeFile, setFile] = React.useState<ManagementAuthFile>(file);
    setActiveFile = setFile;
    return <CredentialRecoveryPanel file={activeFile} canEdit onChanged={changed} />;
  }
  const surface = renderWithOmc(
    <RecoveryHarness />,
    { route: '/omc/oauth-management', isStrict: true },
  );
  try {
    fireEvent.click(surface.baseElement.querySelector('[data-credential-verify]')!);
    const confirmation = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole('button', { name: t('recovery.verify') }));
    });
    const notice = await screen.findByTestId('credential-verify-not-applied');
    expect(notice.textContent).toContain(t('recovery.verify_not_applied'));
    expect(notice.textContent).toContain(t('recovery.verify_not_applied_hint'));
    expect(surface.baseElement.textContent).not.toContain('Inference verification failed');
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));

    // A later successful verify clears the not-applied notice.
    mode = 'verified';
    fireEvent.click(surface.baseElement.querySelector('[data-credential-verify]')!);
    const secondConfirmation = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(secondConfirmation).getByRole('button', { name: t('recovery.verify') }));
    });
    await waitFor(() => expect(screen.queryByTestId('credential-verify-not-applied')).toBeNull());
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));

    // Switching to another credential while verify is in flight must bind the outcome to
    // the verified credential's mutation target rather than showing it on the new credential.
    mode = 'deferred_not_applied';
    fireEvent.click(surface.baseElement.querySelector('[data-credential-verify]')!);
    const thirdConfirmation = await screen.findByRole('dialog');
    fireEvent.click(within(thirdConfirmation).getByRole('button', { name: t('recovery.verify') }));
    await waitFor(() => expect(releaseDeferred).toBeTypeOf('function'));
    await act(async () => { setActiveFile(siblingFile); });
    await act(async () => { releaseDeferred(); });
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId('credential-verify-not-applied')).toBeNull();

    // sandbox_reset renders localized copy rather than raw English error text.
    mode = 'sandbox_reset';
    fireEvent.click(surface.baseElement.querySelector('[data-credential-verify]')!);
    const fourthConfirmation = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(fourthConfirmation).getByRole('button', { name: t('recovery.verify') }));
    });
    await waitFor(() => expect(surface.baseElement.textContent).toContain(t('recovery.verify_sandbox_reset')));
  } finally {
    surface.unmount();
  }
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

it('shows the active Claude OAuth scope in the connect drawer without adding a toggle there', async () => {
  const t = makeT('en');
  const server = installOmcApi();
  server.on('GET', '/management/config', () => ({
    scalars: {},
    supported_keys: [],
    revision: 'rev-default',
    safe_yaml: 'server:\n  port: 8317\n',
    stored_layout: 'v8',
  }));
  const surface = renderWithOmc(<ConnectWorkspace choices={[CHOICES[1], CHOICES[0]]} />, {
    route: '/omc/oauth-management',
    isStrict: true,
  });
  try {
    const scopeBox = await screen.findByTestId('claude-oauth-scope');
    expect(scopeBox.textContent).toContain(t('oauth.anthropic_scope_with_create_key'));
    expect(scopeBox.textContent).toContain('org:create_api_key');
    expect(within(scopeBox).queryByRole('switch')).toBeNull();

    // Switching to another provider hides the Claude scope summary.
    fireEvent.click(screen.getByTestId('other-provider'));
    await waitFor(() => expect(screen.queryByTestId('claude-oauth-scope')).toBeNull());
  } finally { surface.unmount(); }

  // Explicit opt-out in configuration YAML displays only the five user:* scopes.
  server.on('GET', '/management/config', () => ({
    scalars: {},
    supported_keys: [],
    revision: 'rev-opt-out',
    safe_yaml: 'oauth:\n  providers:\n    claude:\n      oauth-include-create-api-key: false\n',
    stored_layout: 'v8',
  }));
  const optOutSurface = renderWithOmc(<ConnectWorkspace choices={[CHOICES[1]]} />, {
    route: '/omc/oauth-management',
    isStrict: true,
  });
  try {
    const scopeBox = await screen.findByTestId('claude-oauth-scope');
    expect(scopeBox.textContent).toContain(t('oauth.anthropic_scope_user_only'));
    expect(scopeBox.textContent).not.toContain('org:create_api_key');
    expect(scopeBox.textContent).toContain('user:profile');
  } finally { optOutSurface.unmount(); }
});

function BuiltinConnectWorkspace({
  initialProviderId = '',
  recovery,
}: {
  initialProviderId?: string;
  recovery?: OAuthRecoveryTarget;
} = {}) {
  const choices = builtinOAuthProviderChoices(useT());
  const [isOpen, setIsOpen] = React.useState(true);
  const [providerId, setProviderId] = React.useState(initialProviderId);
  const sessions = useOAuthSessions(choices);
  return <>
    <output data-testid="sessions">{JSON.stringify(sessions.states)}</output>
    <OAuthConnectPanel
      recoveryTarget={recovery}
      isRecoverySupported={Boolean(recovery)}
      open={isOpen}
      choices={choices}
      selectedProviderId={providerId || undefined}
      onSelectProvider={setProviderId}
      onClose={() => setIsOpen(false)}
      onViewCredentials={() => {}}
      sessions={sessions}
    />
  </>;
}

it('runs GitHub Copilot device sign-in from the picker and supports targeted device recovery', async () => {
  vi.useFakeTimers();
  const server = installOmcApi();
  let statusResult: { status: string } = { status: 'wait' };
  server.on('POST', '/management/oauth/start', () => ({
    url: 'https://github.com/login/device',
    state: 'copilot-device-state',
    session_id: 'copilot-device-state',
    provider: 'copilot',
    flow: 'device',
    user_code: 'WDJB-MJHT',
    expires_in: 900,
  }));
  server.on('GET', '/management/oauth/status', () => statusResult);
  server.on('DELETE', '/management/oauth/session', () => ({ status: 'ok', cancelled: true }));

  const surface = renderWithOmc(<BuiltinConnectWorkspace />, { route: '/omc/oauth-management', isStrict: true });
  const session = () => JSON.parse(screen.getByTestId('sessions').textContent!).copilot;
  try {
    const tile = surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-card="copilot"]');
    expect(tile).toBeTruthy();
    expect(tile?.textContent).toContain('GitHub Copilot OAuth');
    await act(async () => { fireEvent.click(tile!); });

    const start = surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start="copilot"]');
    expect(start).toBeTruthy();
    expect(start?.textContent).toContain('Start GitHub Copilot Sign-in');
    await act(async () => { fireEvent.click(start!); });

    expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([{ provider: 'copilot' }]);
    expect(session()).toMatchObject({ status: 'waiting', flow: 'device', userCode: 'WDJB-MJHT' });
    expect(surface.baseElement.querySelector('[data-oauth-user-code]')?.textContent).toBe('WDJB-MJHT');
    expect(surface.baseElement.querySelector('[data-oauth-callback-input]')).toBeNull();

    statusResult = { status: 'ok' };
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(session().status).toBe('success');
  } finally {
    surface.unmount();
  }

  // Targeted recovery for an expired Copilot credential reuses the same device-code panel and cancel path.
  statusResult = { status: 'wait' };
  const recovery = { name: 'copilot-42.json', auth_index: 'idx-copilot' };
  const recoverySurface = renderWithOmc(
    <BuiltinConnectWorkspace initialProviderId="copilot" recovery={recovery} />,
    { route: '/omc/oauth-management', isStrict: true },
  );
  const recoverySession = () => JSON.parse(screen.getByTestId('sessions').textContent!).copilot;
  try {
    const start = recoverySurface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start="copilot"]')!;
    await act(async () => { fireEvent.click(start); });
    expect(server.writes('/management/oauth/start').at(-1)?.body).toEqual({
      provider: 'copilot',
      name: 'copilot-42.json',
      auth_index: 'idx-copilot',
      verify: false,
    });
    expect(recoverySurface.baseElement.querySelector('[data-oauth-user-code]')?.textContent).toBe('WDJB-MJHT');
    expect(recoverySurface.baseElement.querySelector('[data-oauth-callback-input]')).toBeNull();

    const cancel = within(recoverySurface.baseElement).getByRole('button', { name: makeT('en')('oauth.cancel_session') });
    await act(async () => { fireEvent.click(cancel); });
    expect(server.writes('/management/oauth/session').map(request => request.method)).toEqual(['DELETE']);
    expect(recoverySession().status).toBe('idle');
  } finally {
    recoverySurface.unmount();
    vi.useRealTimers();
  }
});
