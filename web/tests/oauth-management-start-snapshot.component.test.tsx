import { act, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { OAuthManagementPage } from '../src/pages/oauthManagement/OAuthManagementPage';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

const capture = vi.hoisted(() => ({
  onCompleted: undefined as ((providerId: string) => void) | undefined,
  panelSessions: undefined as {
    start: (providerId: string, proxyUrl?: string) => Promise<void>;
    startDefaultRoute: (providerId: string) => Promise<void>;
  } | undefined,
  calls: [] as string[],
}));

vi.mock('../src/pages/oauthManagement/useOAuthSessions', () => ({
  useOAuthSessions: (_choices: unknown, onCompleted: (providerId: string) => void) => {
    capture.onCompleted = onCompleted;
    return {
      states: {},
      activeProviders: [],
      start: async (providerId: string) => { capture.calls.push(`start:${providerId}`); },
      startDefaultRoute: async (providerId: string) => { capture.calls.push(`default:${providerId}`); },
      cancel: async () => {},
      submitCallback: async () => {},
      check: async () => {},
      setCallbackUrl: () => {},
      reset: () => {},
    };
  },
}));

vi.mock('../src/pages/oauthManagement/OAuthConnectPanel', () => ({
  OAuthConnectPanel: (props: { sessions: NonNullable<typeof capture.panelSessions> }) => {
    capture.panelSessions = props.sessions;
    return null;
  },
}));

const INITIAL: ManagementAuthFile = {
  name: 'initial.json', auth_index: 'initial', type: 'codex', provider: 'codex',
  disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0,
};
const CREATED: ManagementAuthFile = {
  name: 'completion-new.json', auth_index: 'completion-new', type: 'kimi', provider: 'kimi',
  disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0,
};

it('records the pre-start snapshot for an explicit default-route controller start', async () => {
  const api = installOmcApi({ authFiles: [{ file: INITIAL, fields: {} }] });
  api.on('GET', '/management/quota', () => ({ quotas: [] }));
  const router = createMemoryRouter([{ path: '*', element: <OAuthManagementPage /> }], {
    initialEntries: ['/oauth-management'],
  });
  const surface = renderWithOmc(<RouterProvider router={router} />);
  try {
    await waitFor(() => expect(surface.baseElement.querySelector('[data-auth-index="initial"]')).toBeTruthy());
    await waitFor(() => expect(capture.panelSessions).toBeTruthy());
    await act(async () => { await capture.panelSessions!.startDefaultRoute('kimi'); });
    expect(capture.calls).toEqual(['default:kimi']);

    api.state.authFiles.push({ file: CREATED, fields: {} });
    await surface.client.invalidateQueries({ queryKey: ['management-auth-files'] });
    await waitFor(() => expect(surface.baseElement.querySelector('[data-auth-index="completion-new"]')).toBeTruthy());
    await act(async () => { capture.onCompleted?.('kimi'); });
    await surface.client.invalidateQueries({ queryKey: ['management-auth-files'] });
    const completion = await waitFor(() => {
      const toast = surface.baseElement.querySelector('.omc-toast');
      expect(toast).toBeTruthy();
      return toast!;
    }, { timeout: 3000 });

    expect(completion.classList.contains('omc-toast-success')).toBe(true);
    expect(completion.classList.contains('omc-toast-warning')).toBe(false);
  } finally {
    surface.unmount();
  }
});
