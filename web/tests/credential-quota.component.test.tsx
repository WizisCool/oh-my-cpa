import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { I18nProvider, makeT } from '../src/i18n';
import {
  CredentialQuotaPanel,
  type CredentialQuotaPanelProps,
} from '../src/components/dashboard/CredentialQuota';
import { buildCredentialQuotaBoard, credentialQuotaRefreshTargets } from '../src/components/dashboard/credentialQuotaLogic';
import { resolveCredentialMark } from '../src/types/brandMark';
import { CredentialQuotaBody } from '../src/pages/quota/CredentialQuotaBody';
import { CredentialList } from '../src/pages/oauthManagement/CredentialList';
import { ProviderStrip } from '../src/pages/oauthManagement/ProviderStrip';
import type { CredentialActions } from '../src/pages/oauthManagement/CredentialParts';
import { OAuthManagementPage } from '../src/pages/oauthManagement/OAuthManagementPage';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { buildCredentialSections } from '../src/pages/oauthManagement/credentialSections';
import { buildOAuthWorkspaceProjection } from '../src/pages/oauthManagement/oauthWorkspaceLogic';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import type { QuotaItem, QuotaWindow } from '../src/types/quota';

const NOW_MS = Date.parse('2026-10-10T08:00:00Z');
const HOUR_MS = 3_600_000;

function file(name: string, overrides: Partial<ManagementAuthFile> = {}): ManagementAuthFile {
  return { name, auth_index: name, type: 'codex', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0, ...overrides };
}

function quotaWindow(kind: 'five_hour' | 'weekly', remaining: number, resetInHours: number): QuotaWindow {
  return { id: kind, label: kind, kind, scope: 'standard', remaining_percent: remaining, reset_at_ms: NOW_MS + resetInHours * HOUR_MS, reset_accuracy: 'exact' };
}

function quota(authIndex: string, windows: QuotaWindow[], overrides: Partial<QuotaItem> = {}): QuotaItem {
  return {
    auth_index: authIndex,
    name: authIndex,
    type: 'codex',
    provider: 'codex',
    disabled: false,
    status: 'healthy',
    observed_at_ms: NOW_MS,
    windows,
    recommendation: { status: 'healthy', priority: 'none', action: 'none', reason: '' },
    capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: false },
    quota_exceeded: false,
    ...overrides,
  };
}

const FILES: ManagementAuthFile[] = [
  file('ample', { email: 'ample@example.com' }),
  file('low'),
  file('cooling'),
  file('expired'),
  file('unread'),
  file('off', { disabled: true }),
  file('configured-key', { runtime_only: true }),
];

const QUOTAS: QuotaItem[] = [
  quota('ample', [quotaWindow('five_hour', 92, 3), quotaWindow('weekly', 80, 100)]),
  quota('low', [quotaWindow('weekly', 12, 30), quotaWindow('five_hour', 64, 2)]),
  quota('cooling', [quotaWindow('five_hour', 40, 2)], { status: 'cooldown', active_cooldown: { is_active: true, recover_at_ms: NOW_MS + 25 * 60_000 } }),
  quota('expired', [], { status: 'error', recommendation: { status: 'needs_reauth', priority: 'critical', action: 'reauth', reason: 'token revoked' } }),
];

function QuotaSurface(props: Partial<CredentialQuotaPanelProps>) {
  return <React.StrictMode><MemoryRouter basename="/omc" initialEntries={['/omc/dashboard']}>
    <I18nProvider><CredentialQuotaPanel nowMS={NOW_MS} {...props} /></I18nProvider>
  </MemoryRouter></React.StrictMode>;
}

const panelState = () => screen.getByTestId('dashboard-credential-quota').getAttribute('data-quota-panel-state');

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
});

describe('credential quota board', () => {
  it('orders credentials by urgency, slots windows accurately, and resolves refresh targets', () => {
    const board = buildCredentialQuotaBoard(FILES, QUOTAS);
    expect(board.rows.map((row) => [row.fileName, row.state])).toEqual([
      ['expired', 'reauth'],
      ['cooling', 'cooldown'],
      ['low', 'low'],
      ['ample', 'healthy'],
      ['unread', 'unread'],
    ]);
    expect(board).toMatchObject({ servingCount: 3, blockedCount: 2, disabledCount: 1 });
    const low = board.rows.find((row) => row.fileName === 'low')!;
    expect(low.slots.map((entry) => entry?.kind)).toEqual(['five_hour', 'weekly']);
    expect(low.bindingWindow?.kind).toBe('weekly');
    expect(low.remainingPercent).toBe(12);

    const weeklyOnly = buildCredentialQuotaBoard([file('weekly-only')], [quota('weekly-only', [quotaWindow('weekly', 60, 30)])]);
    expect(weeklyOnly.rows[0].slots.map((entry) => entry?.kind)).toEqual([undefined, 'weekly']);

    const spent = buildCredentialQuotaBoard(
      [file('spent')],
      [quota('spent', [quotaWindow('five_hour', 0, 2), quotaWindow('weekly', 0, 40)], { status: 'exhausted' })],
    );
    expect(spent.rows[0]).toMatchObject({ state: 'exhausted', recoverAtMS: NOW_MS + 40 * HOUR_MS });

    const quotas = [
      ...QUOTAS,
      quota('off', []),
      quota('unread', [], { capabilities: { refresh_supported: false, clear_cooldown_supported: false, reset_credit_supported: false } }),
    ];
    expect(credentialQuotaRefreshTargets(FILES, quotas)).toEqual(['ample', 'low', 'cooling', 'expired']);
    expect(credentialQuotaRefreshTargets([file('twin'), file('twin')], [quota('twin', [])])).toEqual([]);
  });

  it('carries the portal that issued a credential, so the row draws its mark over the plugin logo', () => {
    const portalLogo = 'data:image/svg+xml,%3Csvg%20id%3D%22harbor-cn%22/%3E';
    const pluginLogo = 'data:image/svg+xml,%3Csvg%20id%3D%22harbor%22/%3E';
    const issued = file('harbor-cn-account', { type: 'harbor', oauth_provider: 'Harbor-CN' });
    // The row model has to carry the issuing portal, because the artwork resolver only walks
    // the keys it is handed: dropping it here is what drew the plugin's own logo.
    const row = buildCredentialQuotaBoard([issued], [], new Set(['harbor', 'harbor-cn'])).rows[0];
    expect(row.credential).toMatchObject({ provider: 'harbor-cn', family: 'harbor' });
    expect(resolveCredentialMark(row.credential, { harbor: pluginLogo, 'harbor-cn': portalLogo }).logo).toBe(portalLogo);
    // A gateway that reports no portal keeps the family's artwork.
    expect(buildCredentialQuotaBoard([file('plain', { type: 'harbor' })], []).rows[0].credential).toMatchObject({ provider: 'harbor' });
  });
});

describe('credential quota presentation', () => {
  it('renders loading, error, empty, and ready states with masked accounts', () => {
    const retry = vi.fn();
    const { rerender } = render(<QuotaSurface isLoading />);
    expect(panelState()).toBe('loading');
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');

    rerender(<QuotaSurface isError error={new Error('read failed')} onRetry={retry} />);
    expect(panelState()).toBe('unknown');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<QuotaSurface files={[]} quotas={[]} />);
    expect(panelState()).toBe('empty');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/omc/oauth-management?action=connect');

    rerender(<QuotaSurface files={FILES} quotas={QUOTAS} />);
    expect(panelState()).toBe('ready');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(within(rows[0]).getByText('Sign-in required')).toBeTruthy();
    expect(within(rows[1]).getByText('Cooling down')).toBeTruthy();
    expect(within(rows[3]).getByText('am•••e@example.com')).toBeTruthy();
    expect(within(rows[4]).getByText('No quota reading')).toBeTruthy();
  });

  it('persists keyboard reordering alongside existing dashboard order keys', async () => {
    const api = installOmcApi();
    api.state.preferences.omc_dashboard_order = { other_list: ['keep'], credential_quota: ['ample', 'low'] };
    const files = FILES.filter((entry) => !entry.disabled && !entry.runtime_only);
    renderWithOmc(<MemoryRouter><CredentialQuotaPanel nowMS={NOW_MS} files={files} quotas={QUOTAS} isSortable /></MemoryRouter>);
    const handleName = (name: string) => `${makeT('en')('common.reorder_handle')}: ${name}`;
    const low = await screen.findByRole('button', { name: handleName('low') });
    const urgency = buildCredentialQuotaBoard(files, QUOTAS).rows.map((row) => row.fileName).filter((name) => name !== 'ample' && name !== 'low');
    fireEvent.keyDown(low, { key: 'ArrowUp' });
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
    expect(api.preferenceWrites()[0]).toEqual({
      key: 'omc_dashboard_order',
      value: { other_list: ['keep'], credential_quota: ['low', 'ample', ...urgency] },
    });
  });
});

describe('credential quota body details', () => {
  const renderBody = (item: QuotaItem) => render(
    <MemoryRouter>
      <I18nProvider>
        <CredentialQuotaBody item={item} credentialLabel={item.name} nowMS={NOW_MS} isDemo={false} />
      </I18nProvider>
    </MemoryRouter>,
  );

  it('displays reset grants, credit balances, and failed refresh diagnostics', () => {
    const { rerender } = renderBody(quota('claude-grants', [], {
      provider: 'claude',
      reset_grants: [
        { id: 'grant-weekly', label: 'Weekly Reset', resets_total: 2, resets_left: 1, ends_at_ms: NOW_MS + 3 * 24 * 60_000, clears: ['five_hour'] },
        { id: 'grant-spent', label: 'Spent', resets_total: 1, resets_left: 0 },
      ],
      plan: {
        plan_type: 'max', plan_label: 'Claude Max', tier: 'elite',
        extra_usage: { is_enabled: false, monthly_limit_cents: 0, used_credits_cents: 0, user_disabled: true },
        balances: [
          { id: 'iguana_necktie', limit_usd: 50, used_usd: 15, remaining_usd: 35, reset_at_ms: NOW_MS + 24 * HOUR_MS },
        ],
      },
    }));
    expect(screen.getByText('Weekly Reset')).toBeTruthy();
    expect(document.querySelector('[data-quota-reset="grant"]')?.textContent).toMatch(/left\s*1\s*\/\s*2/);
    expect(screen.queryByText('Spent')).toBeNull();
    expect(screen.getByText('Cloud session credits')).toBeTruthy();
    expect(screen.getByText(/\$35\.00 left/)).toBeTruthy();

    rerender(
      <MemoryRouter>
        <I18nProvider>
          <CredentialQuotaBody
            item={quota('codex-main', [quotaWindow('five_hour', 100, 600)], {
              status: 'error',
              observed_at_ms: NOW_MS - 3 * 24 * HOUR_MS,
              error: 'HTTP 401: unauthorized',
              recommendation: { status: 'needs_reauth', priority: 'critical', action: 'reauth', reason: 'reauthorize' },
              last_refresh: { attempted_at_ms: NOW_MS - 60_000, outcome: 'failed', error: 'HTTP 401: unauthorized' },
            })}
            credentialLabel="codex-main"
            nowMS={NOW_MS}
            isDemo={false}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText(/Last refresh failed/)).toBeTruthy();
    expect(screen.getAllByText(/HTTP 401: unauthorized/).length).toBeGreaterThan(0);
    expect(screen.getByText('100%')).toBeTruthy();
  });
});

function renderCredentialRow(
  item: QuotaItem,
  { onRefresh, onOpen = vi.fn(), onRename = vi.fn(async () => true), fileOverrides = {} }: {
    onRefresh?: () => void;
    onOpen?: CredentialActions['onOpen'];
    onRename?: CredentialActions['onRename'];
    fileOverrides?: Partial<ManagementAuthFile>;
  } = {},
) {
  const { records } = buildOAuthWorkspaceProjection([file(item.auth_index, fileOverrides)], [item], []);
  const [section] = buildCredentialSections(records, records);
  const actions: CredentialActions = {
    isBusy: () => false, isRefreshingQuota: () => false, siwcBadge: () => undefined,
    onSelect: vi.fn(), onPick: vi.fn(), onToggle: vi.fn(), onDownload: vi.fn(), onDelete: vi.fn(), onOpen, onRename,
    onRefreshQuota: onRefresh ?? vi.fn(), onClearCooldown: vi.fn(), onRedeemCredit: vi.fn(), onReauthenticate: vi.fn(), onOpenSIWC: vi.fn(),
  };
  if (!onRefresh) section.records = section.records.map((record) => ({ ...record, canRefreshQuota: false }));
  return render(
    <MemoryRouter>
      <I18nProvider>
        <CredentialList groups={[{ ...section, title: 'Codex' }]} selectedKeys={new Set()} nowMS={NOW_MS} actions={actions} />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('credential list row', () => {
  it('makes credential warnings reachable by keyboard', async () => {
    renderCredentialRow(quota('warning', []), { fileOverrides: { status_message: 'Credential needs attention' } });
    const warning = screen.getByTestId('oauth-credential-warning');
    expect(warning.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(document, { key: 'Tab' });
    warning.focus();
    expect(document.activeElement).toBe(warning);
    await screen.findByRole('tooltip');
    expect(screen.getByRole('tooltip').textContent).toContain('Credential needs attention');
  });

  it('shows the five-hour and weekly limits in place with reset times, unused window duration, and derived estimate markers', () => {
    const { container } = renderCredentialRow(quota('codex-full', [
      { ...quotaWindow('weekly', 100, 48), reset_accuracy: 'derived' },
      { ...quotaWindow('five_hour', 100, 2), used_percent: 0 },
    ]));
    const cells = container.querySelectorAll<HTMLElement>('[data-quota-window-label]');
    expect(within(cells[0]).getByText('100%')).toBeTruthy();
    expect(within(cells[0]).getByText('5h', { exact: true })).toBeTruthy();
    expect(within(cells[1]).getByText('~2d left')).toBeTruthy();
  });

  it('triggers inline quota refresh, renewal badge navigation, and inline rename', async () => {
    const refresh = vi.fn();
    const onOpen = vi.fn();
    const onRename = vi.fn<CredentialActions['onRename']>(async () => true);
    const { container } = renderCredentialRow(
      quota('codex-stale', [quotaWindow('five_hour', 40, 2)], {
        status: 'stale',
        observed_at_ms: NOW_MS - 8 * HOUR_MS,
        last_refresh: { attempted_at_ms: NOW_MS - 5 * 60_000, outcome: 'failed', error: 'HTTP 401: unauthorized' },
      }),
      {
        onRefresh: refresh,
        onOpen,
        onRename,
        fileOverrides: {
          name: 'codex-1a2b-operator@example.com-plus.json',
          email: 'operator@example.com',
          note: 'two months at half price',
          renewal_state: 'retry_scheduled',
        },
      },
    );

    const refreshBtn = screen.getByTestId('oauth-credential-refresh');
    expect(refreshBtn.getAttribute('data-needs-refresh')).toBe('true');
    fireEvent.click(refreshBtn);
    expect(refresh).toHaveBeenCalledTimes(1);

    const badge = container.querySelector('[data-testid="oauth-credential-renewal-badge"]')!;
    expect(badge.getAttribute('data-renewal-state')).toBe('retry_scheduled');
    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ authIndex: 'codex-stale' }), 'renewal');

    fireEvent.click(screen.getByTestId('oauth-credential-rename'));
    const input = screen.getByTestId('oauth-credential-name-input');
    fireEvent.change(input, { target: { value: 'Team seat' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    await waitFor(() => expect(screen.queryByTestId('oauth-credential-name-input')).toBeNull());
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename.mock.calls[0][1]).toBe('Team seat');
  });
});

describe('provider navigation', () => {
  it('clears provider search when the provider list is closed and reopened', async () => {
    const summaries = Array.from({ length: 8 }, (_, index) => ({ provider: `provider-${index}`, total: 1, attention: 0, disabled: 0 }));
    renderWithOmc(<ProviderStrip summaries={summaries} total={8} attention={0} active="all" onChange={vi.fn()} onConnect={vi.fn()}
      reorder={{ isEnabled: true, onMove: vi.fn(), onStep: vi.fn() }} />);
    fireEvent.click(screen.getByTestId('oauth-provider-switcher'));
    const search = await screen.findByRole('textbox', { name: 'Find a provider' });
    fireEvent.change(search, { target: { value: 'provider-1' } });
    expect(within(screen.getByRole('dialog')).queryByText('All accounts')).toBeNull();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByTestId('oauth-provider-switcher'));
    expect((await screen.findByRole('textbox', { name: 'Find a provider' }) as HTMLInputElement).value).toBe('');
    expect(within(screen.getByRole('dialog')).getByText('All accounts')).toBeTruthy();
  });
});

describe('provider sections across pages', () => {
  it('moves a provider section above the one before it and saves the arrangement', async () => {
    const files = [
      file('codex-main', { type: 'codex', provider: 'codex' }),
      file('claude-main', { type: 'claude', provider: 'claude' }),
    ];
    const api = installOmcApi({ authFiles: files.map(entry => ({ file: entry, fields: {} })) });
    api.on('GET', '/management/quota', () => ({ quotas: [] }));
    const router = createMemoryRouter([{ path: '*', element: <OAuthManagementPage /> }], { initialEntries: ['/oauth-management'] });
    const view = renderWithOmc(<RouterProvider router={router} />);
    const drawnProviders = () => screen.getAllByTestId('oauth-credential-section').map(section => section.getAttribute('data-provider'));
    const sectionWrites = () => api.preferenceWrites().filter(write => write.key === 'omc_oauth_section_order');
    try {
      // The console's own order leads until the operator arranges the sections: Claude is pinned first.
      await waitFor(() => expect(drawnProviders()).toEqual(['claude', 'codex']));
      // The provider list behind the tabs is the arrangement: its grip steps a provider by keyboard.
      fireEvent.click(screen.getByTestId('oauth-provider-switcher'));
      fireEvent.keyDown(await screen.findByRole('button', { name: 'Drag to reorder: Codex' }), { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 });
      await waitFor(() => expect(sectionWrites()).toEqual([{ key: 'omc_oauth_section_order', value: { sections: ['codex', 'claude'] } }]));
      expect(drawnProviders()).toEqual(['codex', 'claude']);
    } finally {
      view.unmount();
    }
  });

  it('sorts a provider by quota across pages and exposes SIWC and reset credit badges', async () => {
    const files = Array.from({ length: 13 }, (_, index) => file(`account-${String(index + 1).padStart(2, '0')}`,
      index === 12 ? { siwc_bound: true, siwc_status: 'valid', use_siwc: true } : {}));
    const quotas = files.map((entry, index) => quota(entry.auth_index!, [quotaWindow('weekly', index === 12 ? 1 : 80 - index, 100)],
      index === 12 ? { reset_credits: { available_count: 2, applicable_available_count: 2 } } : {}));
    const api = installOmcApi({ authFiles: files.map(entry => ({ file: entry, fields: {} })) });
    api.on('GET', '/management/quota', () => ({ quotas }));
    const router = createMemoryRouter([{ path: '*', element: <OAuthManagementPage /> }], { initialEntries: ['/oauth-management?page_size=12'] });
    const view = renderWithOmc(<RouterProvider router={router} />);
    const visibleIdentities = () => screen.getAllByTestId('oauth-credential-record').map(row => row.getAttribute('data-auth-index'));
    try {
      await waitFor(() => expect(visibleIdentities()).toHaveLength(12));
      fireEvent.click(await screen.findByRole('button', { name: /^Sort: / }));
      fireEvent.click(await screen.findByText('Least quota left'));
      await waitFor(() => expect(visibleIdentities()[0]).toBe('account-13'));
      const firstRow = screen.getAllByTestId('oauth-credential-record')[0];
      expect(within(firstRow).getByRole('button', { name: /^SIWC settings:/ }).getAttribute('data-siwc-badge')).toBe('active');
    } finally {
      view.unmount();
    }
  });
});
