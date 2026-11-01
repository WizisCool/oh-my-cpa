import { CredentialRecoveryPanel } from '../src/components/authFiles/CredentialRecoveryPanel';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import type { OAuthRecoveryTarget } from '../src/types/oauth';
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { OAuthConnectPanel } from '../src/pages/oauthManagement/OAuthConnectPanel';
import { useOAuthSessions } from '../src/pages/oauthManagement/useOAuthSessions';
import type { OAuthProviderChoice } from '../src/pages/oauthProviderLogic';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';

const CHOICES: OAuthProviderChoice[] = ['codex', 'anthropic'].map(id => ({
  id, title: id, description: '', iconId: '', flow: 'manual-callback', loginLabel: id,
}));

function ConnectWorkspace({ recovery, isRecoverySupported = true }: { recovery?: OAuthRecoveryTarget; isRecoverySupported?: boolean } = {}) {
  const [isOpen, setIsOpen] = React.useState(true);
  const [providerId, setProviderId] = React.useState('codex');
  const sessions = useOAuthSessions(CHOICES);
  return <>
    <button data-testid="minimize" onClick={() => setIsOpen(false)} />
    <button data-testid="reopen" onClick={() => setIsOpen(true)} />
    <button data-testid="other-provider" onClick={() => setProviderId(current => current === 'codex' ? 'anthropic' : 'codex')} />
    <output data-testid="sessions">{JSON.stringify(sessions.states)}</output>
    <OAuthConnectPanel recoveryTarget={recovery} isRecoverySupported={isRecoverySupported} open={isOpen} choices={CHOICES} selectedProviderId={providerId}
      onSelectProvider={setProviderId} onClose={() => setIsOpen(false)} onViewCredentials={() => {}} sessions={sessions} />
  </>;
}

// This rendered wiring claim is distinct from the Go boundary: the secret must
// travel from the task input through the hook/client once, never into session UI
// state or preferences, while minimizing preserves other providers' attempts.
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
    fireEvent.click(screen.getByTestId('minimize'));
    fireEvent.click(screen.getByTestId('reopen'));
    await waitFor(() => expect(input().value).toBe(''));
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
    await waitFor(() => expect(JSON.parse(screen.getByTestId('sessions').textContent!).codex.status).toBe('waiting'));
    expect(JSON.parse(screen.getByTestId('sessions').textContent!).anthropic.status).toBe('waiting');
    expect(screen.getByTestId('sessions').textContent).not.toContain(proxyURL);
    expect(JSON.stringify(server.state.preferences)).not.toContain(proxyURL);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(proxyURL);
  } finally { surface.unmount(); }
});

it('preserves safe actionable failures and requires fresh proxy intent for both failed-session entrypoints', async () => {
  const proxyURL = 'https://proxy.example.test';
  const server = installOmcApi();
  let failureCode = 'cpa_authentication_failed';
  let shouldSucceed = false;
  server.on('POST', '/management/oauth/start', () => shouldSucceed
    ? { url: 'https://auth.example.test/authorize', state: 'codex-retry' }
    : json({ code: failureCode, error: 'safe actionable detail' }, 502));
  server.on('GET', '/management/oauth/status', () => ({ status: 'wait' }));
  const surface = renderWithOmc(<ConnectWorkspace />, { route: '/omc/oauth-management', isStrict: true });
  const input = () => surface.baseElement.querySelector<HTMLInputElement>('#oauth-connect-proxy')!;
  const start = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start]')!;
  const retry = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-retry]')!;
  const session = () => JSON.parse(screen.getByTestId('sessions').textContent!).codex;
  try {
    await waitFor(() => expect(input()).toBeTruthy());
    for (const code of ['cpa_authentication_failed', 'cpa_v8_required', 'cpa_management_disabled', 'audit_write_failed']) {
      failureCode = code;
      const previousWrites = server.writes('/management/oauth/start').length;
      fireEvent.change(input(), { target: { value: proxyURL } });
      fireEvent.click(start());
      await waitFor(() => expect(server.writes('/management/oauth/start')).toHaveLength(previousWrites + 1));
      await waitFor(() => expect(session().status).toBe('error'));
      expect(input().value).toBe('');
      if (['cpa_authentication_failed', 'cpa_v8_required', 'cpa_management_disabled', 'audit_write_failed'].includes(code)) {
        expect(session().error).toBe('safe actionable detail');
      } else {
        expect(session().error).not.toBe('safe actionable detail');
      }
    }
    // Boundary classifications still hide upstream prose but retain the blocked route intent.
    for (const code of ['cpa_unavailable', 'cpa_rejected_request', 'oauth_proxy_upgrade_required', 'invalid_oauth_proxy']) {
      failureCode = code;
      fireEvent.change(input(), { target: { value: proxyURL } });
      fireEvent.click(start());
      await waitFor(() => expect(session().status).toBe('error'));
      expect(session().error).not.toBe('safe actionable detail');
      expect(input().value).toBe('');
    }
    const failedWrites = server.writes('/management/oauth/start').length;
    expect(start().disabled).toBe(true);
    expect(retry().disabled).toBe(true);
    fireEvent.click(start());
    fireEvent.click(retry());
    expect(server.writes('/management/oauth/start')).toHaveLength(failedWrites);
    fireEvent.click(screen.getByTestId('minimize'));
    fireEvent.click(screen.getByTestId('other-provider'));
    fireEvent.click(screen.getByTestId('other-provider'));
    fireEvent.click(screen.getByTestId('reopen'));
    await waitFor(() => expect(input().value).toBe(''));
    expect(start().disabled).toBe(true);
    expect(retry().disabled).toBe(true);
    fireEvent.click(start());
    fireEvent.click(retry());
    expect(server.writes('/management/oauth/start')).toHaveLength(failedWrites);
    shouldSucceed = true;
    fireEvent.change(input(), { target: { value: proxyURL } });
    fireEvent.click(retry());
    await waitFor(() => expect(session().status).toBe('waiting'));
    expect(server.writes('/management/oauth/start').at(-1)!.body).toEqual({ provider: 'codex', proxy_url: proxyURL });
    expect(screen.getByTestId('sessions').textContent).not.toContain(proxyURL);
  } finally { surface.unmount(); }
});

it('starts the default route after explicit selection and retains ordinary default-route retries', async () => {
  const server = installOmcApi();
  let shouldSucceed = false;
  server.on('POST', '/management/oauth/start', () => shouldSucceed
    ? { url: 'https://auth.example.test/authorize', state: 'default-retry' }
    : json({ code: 'cpa_unavailable', error: 'safe connection detail' }, 502));
  server.on('GET', '/management/oauth/status', () => ({ status: 'wait' }));
  const surface = renderWithOmc(<ConnectWorkspace />, { route: '/omc/oauth-management', isStrict: true });
  const start = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start]')!;
  const session = () => JSON.parse(screen.getByTestId('sessions').textContent!).codex;
  try {
    const input = await waitFor(() => {
      const field = surface.baseElement.querySelector<HTMLInputElement>('#oauth-connect-proxy');
      expect(field).toBeTruthy();
      return field!;
    });
    fireEvent.change(input, { target: { value: 'https://proxy.example.test' } });
    fireEvent.click(start());
    await waitFor(() => expect(session().status).toBe('error'));
    fireEvent.click(surface.baseElement.querySelector('[data-oauth-default-route]')!);
    await waitFor(() => expect(server.writes('/management/oauth/start')).toHaveLength(2));
    await waitFor(() => expect(session().status).toBe('error'));
    expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([
      { provider: 'codex', proxy_url: 'https://proxy.example.test' }, { provider: 'codex' },
    ]);
    expect(surface.baseElement.querySelector('[data-oauth-default-route]')).toBeNull();
    expect(start().disabled).toBe(false);
    const retry = surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-retry]')!;
    expect(retry.disabled).toBe(false);
    shouldSucceed = true;
    fireEvent.click(retry);
    await waitFor(() => expect(session().status).toBe('waiting'));
    expect(server.writes('/management/oauth/start')).toHaveLength(3);
    expect(server.writes('/management/oauth/start').at(-1)!.body).toEqual({ provider: 'codex' });
  } finally { surface.unmount(); }
});


it('requires a fresh route decision when a proxied session later reports a status error', async () => {
  const proxyURL = 'https://proxy.example.test';
  const server = installOmcApi();
  const providerStarts: Record<string, number> = {};
  server.on('POST', '/management/oauth/start', request => {
    const body = request.body as { provider: string; proxy_url?: string };
    providerStarts[body.provider] = (providerStarts[body.provider] ?? 0) + 1;
    const route = body.proxy_url ? 'proxied' : 'default';
    const state = `${body.provider}-${route}-${providerStarts[body.provider]}`;
    return { url: `https://auth.example.test/${state}`, state, flow: 'device', user_code: 'COMPLETE-ME' };
  });
  const errorStatuses = new Set(['codex-proxied-1', 'anthropic-proxied-1']);
  server.on('GET', '/management/oauth/status', request => {
    const state = request.query.get('state') ?? '';
    return errorStatuses.has(state) ? { status: 'error', message: 'session expired' } : { status: 'wait' };
  });

  const surface = renderWithOmc(<ConnectWorkspace />, { route: '/omc/oauth-management', isStrict: true });
  const input = () => surface.baseElement.querySelector<HTMLInputElement>('#oauth-connect-proxy')!;
  const start = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start]')!;
  const retry = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-retry]')!;
  const session = (providerId: string) => JSON.parse(screen.getByTestId('sessions').textContent!)[providerId];
  try {
    await waitFor(() => expect(input()).toBeTruthy());
    fireEvent.change(input(), { target: { value: proxyURL } });
    fireEvent.click(start());
    await waitFor(() => expect(session('codex').status).toBe('waiting'));
    fireEvent.click(screen.getByRole('button', { name: 'Check Authorization Status' }));
    await waitFor(() => expect(session('codex').status).toBe('error'));

    const afterStatusError = server.writes('/management/oauth/start').length;
    expect(start().disabled).toBe(true);
    expect(retry().disabled).toBe(true);
    fireEvent.click(start());
    fireEvent.click(retry());
    expect(server.writes('/management/oauth/start')).toHaveLength(afterStatusError);

    fireEvent.change(input(), { target: { value: proxyURL } });
    fireEvent.click(retry());
    await waitFor(() => expect(session('codex').status).toBe('waiting'));
    expect(server.writes('/management/oauth/start').at(-1)!.body).toEqual({ provider: 'codex', proxy_url: proxyURL });

    fireEvent.click(screen.getByTestId('other-provider'));
    await waitFor(() => expect(input().value).toBe(''));
    fireEvent.change(input(), { target: { value: proxyURL } });
    fireEvent.click(start());
    await waitFor(() => expect(session('anthropic').status).toBe('waiting'));
    fireEvent.click(screen.getByRole('button', { name: 'Check Authorization Status' }));
    await waitFor(() => expect(session('anthropic').status).toBe('error'));

    const afterSecondStatusError = server.writes('/management/oauth/start').length;
    expect(start().disabled).toBe(true);
    expect(retry().disabled).toBe(true);
    fireEvent.click(surface.baseElement.querySelector('[data-oauth-default-route]')!);
    await waitFor(() => expect(server.writes('/management/oauth/start')).toHaveLength(afterSecondStatusError + 1));
    await waitFor(() => expect(session('anthropic').status).toBe('waiting'));
    errorStatuses.add('anthropic-default-2');
    const noProxyRetryCheck = screen.queryByRole('button', { name: 'Check Authorization Status' });
    if (noProxyRetryCheck) fireEvent.click(noProxyRetryCheck);
    await waitFor(() => expect(session('anthropic').status).toBe('error'), { timeout: 4000 });
    expect(start().disabled).toBe(false);
    expect(retry().disabled).toBe(false);
    fireEvent.click(retry());
    await waitFor(() => expect(session('anthropic').status).toBe('waiting'));
    expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([
      { provider: 'codex', proxy_url: proxyURL },
      { provider: 'codex', proxy_url: proxyURL },
      { provider: 'anthropic', proxy_url: proxyURL },
      { provider: 'anthropic' },
      { provider: 'anthropic' },
    ]);
  } finally { surface.unmount(); }
});

it('keeps targeted recovery pinned across failure/minimizing and requires an unchecked verification opt-in', async () => {
  const server = installOmcApi();
  let shouldSucceed = false;
  server.on('POST', '/management/oauth/start', () => shouldSucceed
    ? { url: 'https://auth.example.test/authorize', state: 'targeted-state' }
    : json({ code: 'oauth_recovery_upgrade_required', error: 'upgrade required' }, 501));
  server.on('GET', '/management/oauth/status', () => ({ status: 'wait' }));
  const recovery = { name: 'same-account.json', auth_index: 'account-index' };
  const surface = renderWithOmc(<ConnectWorkspace recovery={recovery} />, { route: '/omc/oauth-management' });
  const start = () => surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start]')!;
  const verification = () => screen.getByRole('checkbox', { name: /Verify inference after sign-in/ });
  try {
    expect((verification() as HTMLInputElement).checked).toBe(false);
    expect(surface.baseElement.querySelector<HTMLInputElement>('#oauth-connect-provider')!.disabled).toBe(true);
    fireEvent.click(start());
    await waitFor(() => expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([{ provider: 'codex', ...recovery, verify: false }]));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('sessions').textContent!).codex.status).toBe('error'));
    fireEvent.click(screen.getByTestId('minimize'));
    fireEvent.click(screen.getByTestId('reopen'));
    expect((verification() as HTMLInputElement).checked).toBe(false);
    expect(surface.baseElement.textContent).toContain('same-account.json');
    shouldSucceed = true;
    fireEvent.click(verification());
    fireEvent.click(start());
    await waitFor(() => expect(server.writes('/management/oauth/start').map(request => request.body)).toEqual([
      { provider: 'codex', ...recovery, verify: false }, { provider: 'codex', ...recovery, verify: true },
    ]));
    expect(JSON.parse(screen.getByTestId('sessions').textContent!).codex.recoveryTarget.name).toBe(recovery.name);
    fireEvent.click(screen.getByTestId('minimize'));
    fireEvent.click(screen.getByTestId('reopen'));
    expect((verification() as HTMLInputElement).checked).toBe(true);
    expect((verification() as HTMLInputElement).disabled).toBe(true);
  } finally { surface.unmount(); }
});

it('does not offer an ordinary login as a fallback for unsupported targeted recovery', () => {
  const server = installOmcApi();
  const surface = renderWithOmc(<ConnectWorkspace recovery={{ name: 'old.json', auth_index: 'old' }} isRecoverySupported={false} />, { route: '/omc/oauth-management' });
  try {
    expect(surface.baseElement.querySelector<HTMLButtonElement>('[data-oauth-start]')!.disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Verify inference after sign-in/ }) as HTMLInputElement).disabled).toBe(true);
    expect(server.writes('/management/oauth/start')).toHaveLength(0);
  } finally { surface.unmount(); }
});

it.each([true, false])('verifies the selected credential only when confirmation is accepted: %s', async (shouldConfirm) => {
  const server = installOmcApi();
  server.on('POST', '/management/auth-files/verify', () => ({ status: 'ok', verified: true }));
  const changed = vi.fn();
  const file: ManagementAuthFile = {
    name: 'selected.json', auth_index: 'selected', provider: 'codex', disabled: false, unavailable: false, runtime_only: false,
    success: 0, failed: 0, recovery_supported: true, requires_sign_in: false, renewal_state: 'awaiting_first_renewal',
    recovery_stage: 'inference_verified', adopted: true, inference_verified: true, renewal_verified: false,
  };
  const surface = renderWithOmc(<CredentialRecoveryPanel file={file} canEdit onChanged={changed} />);
  try {
    fireEvent.click(surface.baseElement.querySelector('[data-credential-verify]')!);
    const confirmation = await screen.findByRole('dialog');
    expect(server.writes('/management/auth-files/verify')).toHaveLength(0);
    await act(async () => { fireEvent.click(within(confirmation).getByRole('button', { name: shouldConfirm ? 'Verify inference (uses tokens)' : 'Cancel' })); });
    if (shouldConfirm) {
      await waitFor(() => expect(server.writes('/management/auth-files/verify').map(request => request.body)).toEqual([{ name: 'selected.json', auth_index: 'selected' }]));
      await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    } else {
      expect(server.writes('/management/auth-files/verify')).toHaveLength(0);
      expect(changed).not.toHaveBeenCalled();
    }
  } finally { surface.unmount(); }
});
