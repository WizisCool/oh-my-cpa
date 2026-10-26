import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { OAuthConnectPanel } from '../src/pages/oauthManagement/OAuthConnectPanel';
import { useOAuthSessions } from '../src/pages/oauthManagement/useOAuthSessions';
import type { OAuthProviderChoice } from '../src/pages/oauthProviderLogic';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';

const CHOICES: OAuthProviderChoice[] = ['codex', 'anthropic'].map(id => ({
  id, title: id, description: '', iconId: '', flow: 'manual-callback', loginLabel: id,
}));

function ConnectWorkspace() {
  const [isOpen, setIsOpen] = React.useState(true);
  const [providerId, setProviderId] = React.useState('codex');
  const sessions = useOAuthSessions(CHOICES);
  return <>
    <button data-testid="minimize" onClick={() => setIsOpen(false)} />
    <button data-testid="reopen" onClick={() => setIsOpen(true)} />
    <button data-testid="other-provider" onClick={() => setProviderId(current => current === 'codex' ? 'anthropic' : 'codex')} />
    <output data-testid="sessions">{JSON.stringify(sessions.states)}</output>
    <OAuthConnectPanel open={isOpen} choices={CHOICES} selectedProviderId={providerId}
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

it('clears the input and offers localized upgrade guidance when CPA lacks session proxies', async () => {
  const server = installOmcApi();
  server.on('POST', '/management/oauth/start', () => json({ code: 'oauth_proxy_upgrade_required', error: 'server detail' }, 501));
  const surface = renderWithOmc(<ConnectWorkspace />, { route: '/omc/oauth-management', isStrict: true });
  try {
    const input = await waitFor(() => {
      const field = surface.baseElement.querySelector<HTMLInputElement>('#oauth-connect-proxy');
      expect(field).toBeTruthy();
      return field!;
    });
    fireEvent.change(input, { target: { value: 'https://proxy.example.test' } });
    fireEvent.click(surface.baseElement.querySelector('[data-oauth-start]')!);
    await waitFor(() => expect(JSON.parse(screen.getByTestId('sessions').textContent!).codex.status).toBe('error'));
    expect(surface.baseElement.querySelector<HTMLInputElement>('#oauth-connect-proxy')!.value).toBe('');
    expect(JSON.parse(screen.getByTestId('sessions').textContent!).codex.error).not.toContain('server detail');
    expect(server.writes('/management/oauth/start')).toHaveLength(1);
  } finally { surface.unmount(); }
});
