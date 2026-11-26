import React from 'react';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { I18nProvider, makeT } from '../src/i18n';
import {
  CredentialQuotaPanel,
  type CredentialQuotaPanelProps,
} from '../src/components/dashboard/CredentialQuota';
import {
  ModelPanelsProvider,
  ModelTrendPanel,
  ModelUsagePanel,
} from '../src/components/dashboard/ModelUsagePanels';
import { TokenHeatmap } from '../src/components/dashboard/TokenHeatmap';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { TokenDisplayProvider } from '../src/types/tokenDisplayContext';
import { CurrencyDisplayProvider } from '../src/types/CurrencyDisplayContext';
import { buildCredentialQuotaBoard, credentialQuotaRefreshTargets } from '../src/components/dashboard/credentialQuotaLogic';
import { resolveCredentialMark } from '../src/types/brandMark';
import { CredentialQuotaBody } from '../src/pages/quota/CredentialQuotaBody';
import { QuotaCapacityButton, QuotaCapacityScope } from '../src/pages/quota/QuotaCapacityButton';
import QuotaCapacityDialog from '../src/pages/quota/QuotaCapacityDialog';
import { CredentialList } from '../src/pages/oauthManagement/CredentialList';
import { ProviderStrip } from '../src/pages/oauthManagement/ProviderStrip';
import type { CredentialActions } from '../src/pages/oauthManagement/CredentialParts';
import { OAuthManagementPage } from '../src/pages/oauthManagement/OAuthManagementPage';
import { BatchActionBar } from '../src/components/authFiles/BatchActionBar';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { buildCredentialSections } from '../src/pages/oauthManagement/credentialSections';
import { buildOAuthWorkspaceProjection } from '../src/pages/oauthManagement/oauthWorkspaceLogic';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import type { CodexResetCreditsInfo, QuotaItem, QuotaWindow, QuotaWindowCapacity } from '../src/types/quota';

vi.mock('../src/components/dashboard/RollingNumber', () => ({
  RollingNumber: ({ readout }: { readout?: { number: number; prefix?: string; suffix: string; format: Intl.NumberFormatOptions } }) =>
    <>{readout ? `${readout.prefix ?? ''}${new Intl.NumberFormat('en', readout.format).format(readout.number)}${readout.suffix}` : '—'}</>,
}));

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

  it('lists every Codex reset credit in expiry order instead of only the earliest one', () => {
    const onRedeem = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <I18nProvider>
          <CredentialQuotaBody
            item={quota('codex-credits', [quotaWindow('five_hour', 20, 3)], {
              capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
              reset_credits: {
                available_count: 3,
                applicable_available_count: 1,
                credits: [
                  { id: 'c-3', status: 'available', expires_at_ms: NOW_MS + 20 * 24 * HOUR_MS },
                  { id: 'c-1', status: 'available', expires_at_ms: NOW_MS + 3 * 24 * HOUR_MS },
                  { id: 'c-2', status: 'available', expires_at_ms: NOW_MS + 10 * 24 * HOUR_MS },
                ],
              },
            })}
            credentialLabel="codex-credits"
            nowMS={NOW_MS}
            isDemo={false}
            onRedeemCredit={onRedeem}
          />
        </I18nProvider>
      </MemoryRouter>,
    );

    const card = document.querySelector<HTMLElement>('[data-quota-reset="credits"]')!;
    expect(card).toBeTruthy();
    expect(within(card).getByText('Reset credits')).toBeTruthy();
    expect(within(card).getByText('3')).toBeTruthy();
    expect(within(card).getByText('Applicable 1')).toBeTruthy();

    const rows = Array.from(card.querySelectorAll<HTMLElement>('[data-quota-reset-credit]'));
    expect(rows.map((row) => row.getAttribute('data-quota-reset-credit'))).toEqual(['c-1', 'c-2', 'c-3']);
    expect(rows[0].textContent).toContain('Credit #1');
    expect(rows[0].textContent).toContain('3d left');
    expect(rows[1].textContent).toContain('Credit #2');
    expect(rows[1].textContent).toContain('10d left');
    expect(rows[2].textContent).toContain('Credit #3');
    expect(rows[2].textContent).toContain('20d left');
    expect(within(card).getByRole('button', { name: 'Reset quota' })).toBeTruthy();

    // Also retains stale/expired and undated entries when available_count > 0, and stays clean when credits list is absent.
    rerender(
      <MemoryRouter>
        <I18nProvider>
          <CredentialQuotaBody
            item={quota('codex-credits', [quotaWindow('five_hour', 20, 3)], {
              capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
              reset_credits: {
                available_count: 2,
                applicable_available_count: 2,
                credits: [
                  { id: 'c-expired', status: 'available', expires_at_ms: NOW_MS - HOUR_MS },
                  { id: 'c-undated', status: 'available' },
                ],
              },
            })}
            credentialLabel="codex-credits"
            nowMS={NOW_MS}
            isDemo={false}
            onRedeemCredit={onRedeem}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    const staleRows = Array.from(document.querySelectorAll<HTMLElement>('[data-quota-reset-credit]'));
    expect(staleRows).toHaveLength(2);
    expect(staleRows[0].querySelector('[data-expired="true"]')?.textContent).toBe('Expired');
    expect(staleRows[1].textContent).toContain('—');

    rerender(
      <MemoryRouter>
        <I18nProvider>
          <CredentialQuotaBody
            item={quota('codex-credits', [quotaWindow('five_hour', 20, 3)], {
              capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
              reset_credits: { available_count: 2, applicable_available_count: 2 },
            })}
            credentialLabel="codex-credits"
            nowMS={NOW_MS}
            isDemo={false}
            onRedeemCredit={onRedeem}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(document.querySelector('[data-quota-reset="credits"]')).toBeTruthy();
    expect(document.querySelector('[data-quota-reset-list="credits"]')).toBeNull();

    rerender(
      <MemoryRouter>
        <I18nProvider>
          <CredentialQuotaBody
            item={quota('codex-credits', [quotaWindow('five_hour', 20, 3)], {
              capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
              reset_credits: {
                available_count: 0,
                applicable_available_count: 0,
                credits: [{ id: 'c-stale', status: 'available', expires_at_ms: NOW_MS + HOUR_MS }],
              },
            })}
            credentialLabel="codex-credits"
            nowMS={NOW_MS}
            isDemo={false}
            onRedeemCredit={onRedeem}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(document.querySelector('[data-quota-reset="credits"]')).toBeNull();
  });

  it('keeps the drawer read-only and spends a credit only through the redemption dialog', async () => {
    const onRedeem = vi.fn(async () => undefined);
    const body = (resetCredits: CodexResetCreditsInfo, isDemo = false) => (
      <MemoryRouter>
        <I18nProvider>
          <CredentialQuotaBody
            item={quota('codex-select', [quotaWindow('five_hour', 20, 3)], {
              capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
              reset_credits: resetCredits,
            })}
            credentialLabel="Primary Codex"
            nowMS={NOW_MS}
            isDemo={isDemo}
            onRedeemCredit={onRedeem}
          />
        </I18nProvider>
      </MemoryRouter>
    );
    const threeCredits: CodexResetCreditsInfo = {
      available_count: 3,
      applicable_available_count: 3,
      credits: [
        { id: 'c-3', status: 'available', expires_at_ms: NOW_MS + 20 * 24 * HOUR_MS },
        { id: 'c-1', status: 'available', expires_at_ms: NOW_MS + 3 * 24 * HOUR_MS },
        { id: 'c-2', status: 'available', expires_at_ms: NOW_MS + 10 * 24 * HOUR_MS },
      ],
    };
    const { rerender } = render(body(threeCredits));
    const openDialog = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset quota' }));
      return screen.findByRole('dialog');
    };
    const choices = (dialog: HTMLElement) =>
      within(within(dialog).getByRole('radiogroup', { name: 'Credit to redeem' })).getAllByRole('radio');

    // Browsing carries no choice: no radios, nothing preselected, and a card click opens nothing.
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-quota-reset-credit]'));
    expect(cards.map((card) => card.getAttribute('data-quota-reset-credit'))).toEqual(['c-1', 'c-2', 'c-3']);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(document.querySelector('[data-quota-reset="credits"] [aria-checked], [data-quota-reset="credits"] [data-selected]')).toBeNull();
    fireEvent.click(cards[0]);
    expect(screen.queryByRole('dialog')).toBeNull();

    // Reset quota opens the dialog on the earliest-expiring credit; picking only moves the choice.
    let dialog = await openDialog();
    expect(dialog.textContent).toContain('Primary Codex');
    let radios = choices(dialog);
    expect(radios.map((radio) => radio.getAttribute('data-redeem-credit'))).toEqual(['c-1', 'c-2', 'c-3']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect(radios[0].textContent).toContain('Expires first');
    fireEvent.click(radios[1]);
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(radios[1], { key: 'ArrowDown' });
    expect(radios[2].getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(radios[2], { key: 'Home' });
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(radios[0], { key: 'End' });
    expect(radios[2].getAttribute('aria-checked')).toBe('true');

    // Cancel spends nothing, and the next opening starts from the default again.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onRedeem).not.toHaveBeenCalled();
    dialog = await openDialog();
    radios = choices(dialog);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');

    // If a background refresh removes the selected credit while the dialog is open, confirmation is
    // blocked instead of silently switching to another credit; the operator must pick again.
    rerender(body({
      available_count: 1,
      applicable_available_count: 1,
      credits: [{ id: 'c-2', status: 'available', expires_at_ms: NOW_MS + 10 * 24 * HOUR_MS }],
    }));
    const confirmWhileStale = within(dialog).getByRole('button', { name: 'Redeem credit' }) as HTMLButtonElement;
    expect(confirmWhileStale.disabled).toBe(true);
    expect(dialog.textContent).toContain(makeT('en')('quota.reset_credit_selection_changed'));
    const remainingRadios = choices(dialog);
    expect(remainingRadios.map((radio) => radio.getAttribute('data-redeem-credit'))).toEqual(['c-2']);
    expect(remainingRadios[0].getAttribute('aria-checked')).toBe('false');
    fireEvent.click(remainingRadios[0]);
    expect(remainingRadios[0].getAttribute('aria-checked')).toBe('true');
    expect(confirmWhileStale.disabled).toBe(false);
    // If a refresh drops the credit details entirely after an explicit credit was chosen,
    // confirmation stays blocked rather than downgrading to automatic backend selection.
    rerender(body({ available_count: 1, applicable_available_count: 1 }));
    expect(confirmWhileStale.disabled).toBe(true);
    expect(dialog.textContent).toContain(makeT('en')('quota.reset_credit_none_eligible'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onRedeem).not.toHaveBeenCalled();

    rerender(body(threeCredits));
    dialog = await openDialog();
    radios = choices(dialog);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    fireEvent.click(radios[2]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Redeem credit' }));
    await waitFor(() => expect(onRedeem).toHaveBeenCalledWith('codex-select', 'c-3'));
    expect(onRedeem).toHaveBeenCalledTimes(1);

    // One spendable credit is shown plainly and still confirmed by its ID.
    rerender(body({
      available_count: 2,
      applicable_available_count: 2,
      credits: [
        { id: 'c-expired', status: 'available', expires_at_ms: NOW_MS - HOUR_MS },
        { id: 'c-undated', status: 'available' },
      ],
    }));
    dialog = await openDialog();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(dialog.querySelector('[data-redeem-credit="c-undated"]')?.textContent).toContain('Credit #2');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Redeem credit' }));
    await waitFor(() => expect(onRedeem).toHaveBeenLastCalledWith('codex-select', 'c-undated'));

    // Without a listed bank the dialog says the earliest-expiring credit goes and sends no ID.
    rerender(body({ available_count: 2, applicable_available_count: 2 }));
    dialog = await openDialog();
    expect(dialog.textContent).toContain('earliest-expiring reset credit for Primary Codex');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Redeem credit' }));
    await waitFor(() => expect(onRedeem).toHaveBeenLastCalledWith('codex-select', undefined));

    // Every listed credit expired: the entry is disabled and says why.
    rerender(body({
      available_count: 1,
      applicable_available_count: 1,
      credits: [{ id: 'c-expired', status: 'available', expires_at_ms: NOW_MS - HOUR_MS }],
    }));
    let entry = screen.getByRole('button', { name: 'Reset quota' }) as HTMLButtonElement;
    expect(entry.disabled).toBe(true);
    expect(entry.getAttribute('data-tip')).toBe(makeT('en')('quota.reset_credit_none_eligible'));

    rerender(body(threeCredits, true));
    entry = screen.getByRole('button', { name: 'Reset quota' }) as HTMLButtonElement;
    expect(entry.disabled).toBe(true);
    expect(entry.getAttribute('data-tip')).toBe(makeT('en')('demo.blocked'));
    expect(onRedeem).toHaveBeenCalledTimes(3);
  });

});

function renderCredentialRow(
  item: QuotaItem,
  { onRefresh, onOpen = vi.fn(), onRename = vi.fn(async () => true), onRedeemCredit = vi.fn(), fileOverrides = {} }: {
    onRefresh?: () => void;
    onOpen?: CredentialActions['onOpen'];
    onRename?: CredentialActions['onRename'];
    onRedeemCredit?: CredentialActions['onRedeemCredit'];
    fileOverrides?: Partial<ManagementAuthFile>;
  } = {},
) {
  const { records } = buildOAuthWorkspaceProjection([file(item.auth_index, fileOverrides)], [item], []);
  const [section] = buildCredentialSections(records, records);
  const actions: CredentialActions = {
    isBusy: () => false, isRefreshingQuota: () => false, siwcBadge: () => undefined,
    onSelect: vi.fn(), onPick: vi.fn(), onToggle: vi.fn(), onDownload: vi.fn(), onDelete: vi.fn(), onOpen, onRename,
    onRefreshQuota: onRefresh ?? vi.fn(), onClearCooldown: vi.fn(), onRedeemCredit, onReauthenticate: vi.fn(), onOpenSIWC: vi.fn(), onOpenModelRules: vi.fn(),
  };
  if (!onRefresh) section.records = section.records.map((record) => ({ ...record, canRefreshQuota: false }));
  return render(
    <MemoryRouter>
      <I18nProvider>
        <CredentialList groups={[{ ...section, title: 'Codex' }]} selectedKeys={new Set()} isSelecting={false} nowMS={NOW_MS} actions={actions} />
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
      { ...quotaWindow('five_hour', 100, 5), used_percent: 0 },
    ]));
    const cells = container.querySelectorAll<HTMLElement>('[data-quota-window-label]');
    expect(within(cells[0]).getByText('100%')).toBeTruthy();
    expect(within(cells[0]).getByText('5h', { exact: true })).toBeTruthy();
    expect(within(cells[1]).getByText('~2d left')).toBeTruthy();
  });

  it('hides capacity trigger when a window has no capacity estimate and shows estimated full total when available', () => {
    const { container } = renderCredentialRow(quota('codex-forecast-row', [
      {
        ...quotaWindow('five_hour', 80, 3),
        capacity: {
          basis: 'current_window', sample_requests: 10, sample_priced_requests: 10,
          requests: 50, tokens: 500_000, cost_nanos: 12_340_000_000,
        },
      },
      {
        ...quotaWindow('weekly', 100, 48),
        capacity_unavailable: 'low_usage',
      },
    ]));
    const cells = container.querySelectorAll<HTMLElement>('[data-quota-window-label]');
    expect(within(cells[0]).getByRole('button', { name: '≈ $12.34' })).toBeTruthy();
    expect(within(cells[1]).queryByText('Usage details')).toBeNull();
    expect(within(cells[1]).queryByRole('button')).toBeNull();
  });

  it('keeps an open row capacity dialog mounted if a refresh clears live capacity', async () => {
    const api = installOmcApi();
    api.on('GET', '/management/quota/codex-refresh/capacity', () => ({
      window_id: 'five_hour',
      current: null,
      previous: null,
      capacity_unavailable: 'no_traffic',
    }));
    const withForecast = quota('codex-refresh', [{
      ...quotaWindow('five_hour', 80, 3),
      capacity: {
        basis: 'current_window', sample_requests: 10, sample_priced_requests: 10,
        requests: 50, tokens: 500_000, cost_nanos: 12_340_000_000,
      },
    }]);
    const withoutForecast = quota('codex-refresh', [{
      ...quotaWindow('five_hour', 75, 3),
      usage: { from_ms: NOW_MS - HOUR_MS, to_ms: NOW_MS, requests: 0, priced_requests: 0, tokens: 0, cost_nanos: 0 },
      capacity_unavailable: 'no_traffic',
    }]);
    const actions: CredentialActions = {
      isBusy: () => false, isRefreshingQuota: () => false, siwcBadge: () => undefined,
      onSelect: vi.fn(), onPick: vi.fn(), onToggle: vi.fn(), onDownload: vi.fn(), onDelete: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(async () => true),
      onRefreshQuota: vi.fn(), onClearCooldown: vi.fn(), onRedeemCredit: vi.fn(), onReauthenticate: vi.fn(), onOpenSIWC: vi.fn(), onOpenModelRules: vi.fn(),
    };
    let setItem!: (item: QuotaItem) => void;
    const Host = () => {
      const [item, _setItem] = React.useState(withForecast);
      setItem = _setItem;
      const { records } = buildOAuthWorkspaceProjection([file(item.auth_index)], [item], []);
      const [section] = buildCredentialSections(records, records);
      return <CredentialList groups={[{ ...section, title: 'Codex' }]} selectedKeys={new Set()} isSelecting={false} nowMS={NOW_MS} actions={actions} />;
    };

    const view = renderWithOmc(<Host />, { route: '/oauth-management' });
    try {
      fireEvent.click(screen.getByRole('button', { name: '≈ $12.34' }));
      expect(await screen.findByRole('dialog')).toBeTruthy();

      act(() => setItem(withoutForecast));
      await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('No requests recorded yet')).toBeTruthy());
      expect(screen.queryByRole('button', { name: '≈ $12.34' })).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('triggers inline quota refresh, renewal badge navigation, and inline rename', async () => {
    const refresh = vi.fn();
    const onOpen = vi.fn();
    const onRename = vi.fn<CredentialActions['onRename']>(async () => true);
    const { container } = renderCredentialRow(
      quota('codex-stale', [
        quotaWindow('five_hour', 40, 2),
        { id: 'ag_req', label: 'Gemini Models · Requests', kind: 'five_hour', scope: 'group', period_hours: 5, remaining_percent: 80 },
        { id: 'ag_tok', label: 'Gemini Models · Tokens', kind: 'five_hour', scope: 'group', period_hours: 5, remaining_percent: 60 },
      ], {
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

    expect(screen.getByRole('group', { name: 'Gemini Models 5-hour limit (Requests)' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Gemini Models 5-hour limit (Tokens)' })).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Gemini Models 5-hour limit (Requests)' })).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Gemini Models 5-hour limit (Tokens)' })).toBeTruthy();

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

  it('opens the shared redemption dialog from the row menu and spends only after confirmation', async () => {
    const onRedeemCredit = vi.fn(async () => undefined);
    renderCredentialRow(
      quota('codex-menu-redeem', [quotaWindow('five_hour', 20, 3)], {
        capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
        reset_credits: {
          available_count: 2,
          applicable_available_count: 2,
          credits: [
            { id: 'c-late', status: 'available', expires_at_ms: Date.now() + 14 * 24 * HOUR_MS },
            { id: 'c-early', status: 'available', expires_at_ms: Date.now() + 3 * 24 * HOUR_MS },
          ],
        },
      }),
      { onRedeemCredit, fileOverrides: { display_name: 'Primary Codex' } },
    );
    const openFromMenu = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More actions: codex-menu-redeem' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Use a reset' }));
      return screen.findByRole('dialog');
    };

    let dialog = await openFromMenu();
    expect(onRedeemCredit).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('Primary Codex');
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('data-redeem-credit'))).toEqual(['c-early', 'c-late']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onRedeemCredit).not.toHaveBeenCalled();

    dialog = await openFromMenu();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Redeem credit' }));
    await waitFor(() => expect(onRedeemCredit).toHaveBeenCalledWith(expect.objectContaining({ authIndex: 'codex-menu-redeem' }), 'c-early'));
    expect(onRedeemCredit).toHaveBeenCalledTimes(1);
  });
});

describe('OAuth selection bar', () => {
  it('spins only the batch action it started, and only until that action settles', async () => {
    let settleRefresh = () => {};
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => { settleRefresh = resolve; }));
    const bar = (isMutating: boolean) => (
      <BatchActionBar
        selectedCount={2}
        selectablePageCount={4}
        selectableFilteredCount={9}
        canSelectFiltered
        isSelectionReady
        onSelectFiltered={vi.fn()}
        isMutating={isMutating}
        onSelectPage={vi.fn()}
        onClearSelection={vi.fn()}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRefresh={onRefresh}
        canRefresh
        onDelete={vi.fn()}
      />
    );
    const view = render(bar(false), { wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider> });
    const busyLabels = () => Array.from(document.querySelectorAll('.selection-bar [aria-busy="true"]'), (node) => node.textContent);

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    view.rerender(bar(true));
    expect(busyLabels()).toEqual([expect.stringMatching(/refresh/i)]);

    await act(async () => { settleRefresh(); });
    view.rerender(bar(false));
    // The workspace's busy flag is shared with uploads and row actions; a later one spins nothing here.
    view.rerender(bar(true));
    expect(busyLabels()).toEqual([]);
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

  it('dismisses and blocks row capacity dialogs while a page overlay is active', async () => {
    const api = installOmcApi();
    api.on('GET', '/management/quota/acct-1/capacity', () => ({ current: null, previous: null }));
    const windowItem: QuotaWindow = {
      ...quotaWindow('five_hour', 70, 2),
      capacity_unavailable: 'low_usage',
    };
    const owner = { authIndex: 'acct-1', credentialName: 'Primary' };
    let setBlocked!: (blocked: boolean) => void;
    const Host = () => {
      const [blocked, _setBlocked] = React.useState(false);
      setBlocked = _setBlocked;
      return (
        <QuotaCapacityScope isBlocked={blocked}>
          <QuotaCapacityButton owner={owner} window={windowItem}>Usage details</QuotaCapacityButton>
        </QuotaCapacityScope>
      );
    };
    const view = renderWithOmc(<Host />);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Usage details' }));
      expect(await screen.findByRole('dialog')).toBeTruthy();

      act(() => setBlocked(true));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      // Clicking while blocked does not reopen the row dialog.
      fireEvent.click(screen.getByRole('button', { name: 'Usage details' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      view.unmount();
    }
  });
});

describe('quota consumption and window capacity dialog', () => {
  it('switches periods and displays full-window capacity alongside previous-window fallback provenance', async () => {
    const api = installOmcApi();
    const cap = (basis: QuotaWindowCapacity['basis'], requests: number, costDollars: number): QuotaWindowCapacity => ({
      basis, sample_requests: 90, sample_priced_requests: 90,
      requests, tokens: requests * 20_000, cost_nanos: costDollars * 1_000_000_000, cache_rate: 80,
    });
    const fiveHour: QuotaWindow = {
      ...quotaWindow('five_hour', 80, 3), period_hours: 5,
      usage: { from_ms: NOW_MS - 2 * HOUR_MS, to_ms: NOW_MS, requests: 90, priced_requests: 90, tokens: 1_750_000, cache_rate: 78.5, cost_nanos: 10_000_000_000 },
      capacity: cap('current_window', 450, 50),
    };
    const weekly: QuotaWindow = {
      ...quotaWindow('weekly', 100, 100), id: 'seven_day', period_hours: 168,
      capacity: cap('previous_window', 1000, 200),
    };
    api.on('GET', '/management/quota/gemini-seat/capacity', (req) => {
      const active = req.query.get('window') === 'seven_day' ? weekly : fiveHour;
      return {
        window_id: active.id,
        current: active.usage ? { from_ms: active.usage.from_ms, reset_at_ms: active.reset_at_ms, used_percent: 100 - active.remaining_percent!, usage: active.usage } : null,
        previous: null,
        capacity: active.capacity,
      };
    });
    const view = renderWithOmc(<QuotaCapacityDialog open onClose={vi.fn()} owner={{ authIndex: 'gemini-seat', credentialName: 'Gemini Pro' }} window={fiveHour} windows={[fiveHour, weekly]} />);
    try {
      const dialog = await screen.findByRole('dialog');
      const capacityCard = within(dialog).getByRole('region', { name: 'Estimated quota' });
      await waitFor(() => expect(capacityCard.textContent).toContain('$50.00'));
      expect(capacityCard.textContent).toContain('450');
      expect(within(dialog).getByRole('region', { name: 'This window' }).textContent).toContain('$10.00');
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Weekly limit' }));
      await waitFor(() => expect(capacityCard.textContent).toContain('$200.00'));
      expect(capacityCard.textContent).toContain('1,000');
      expect(capacityCard.textContent).toContain('From last window');
    } finally { view.unmount(); }
  });

  it('clears a stale inline capacity when the fresh details report no recorded traffic', async () => {
    const api = installOmcApi();
    api.on('GET', '/management/quota/mixed-seat/capacity', () => ({ window_id: 'five_hour', current: null, previous: null, capacity_unavailable: 'no_traffic' }));
    const windowItem: QuotaWindow = {
      ...quotaWindow('five_hour', 80, 3),
      capacity: { basis: 'current_window', sample_requests: 10, requests: 123, tokens: 12300 },
    };
    const view = renderWithOmc(<QuotaCapacityDialog open onClose={vi.fn()} owner={{ authIndex: 'mixed-seat', credentialName: 'Gemini Pro' }} window={windowItem} />);
    try {
      const dialog = await screen.findByRole('dialog');
      const capacityCard = within(dialog).getByRole('region', { name: 'Estimated quota' });
      await waitFor(() => {
        expect(within(capacityCard).getByText('No requests recorded yet')).toBeTruthy();
        expect(capacityCard.textContent).not.toContain('123');
      });
    } finally { view.unmount(); }
  });

  it('lazy-loads subscription-cycle totals when switching to Subscription cycle and omits the tab on group windows', async () => {
    const api = installOmcApi();
    let subscriptionCalls = 0;
    let failSubscription = false;
    const fiveHour: QuotaWindow = {
      ...quotaWindow('five_hour', 60, 3), period_hours: 5,
      usage: { from_ms: NOW_MS - 2 * HOUR_MS, to_ms: NOW_MS, requests: 40, priced_requests: 40, tokens: 500_000, cost_nanos: 5_000_000_000 },
    };
    const weekly: QuotaWindow = { ...quotaWindow('weekly', 40, 100), id: 'weekly', period_hours: 168 };
    api.on('GET', '/management/quota/codex-sub/capacity', () => ({
      window_id: 'five_hour',
      current: { from_ms: NOW_MS - 2 * HOUR_MS, reset_at_ms: NOW_MS + 3 * HOUR_MS, used_percent: 40, usage: fiveHour.usage },
      previous: null,
    }));
    api.on('GET', '/management/quota/codex-sub/subscription-cycle', () => {
      subscriptionCalls += 1;
      if (failSubscription) throw new Error('subscription cycle unavailable');
      return {
        source: 'live_subscription',
        plan_label: 'Pro 200',
        current: {
          from_ms: NOW_MS - 15 * 24 * HOUR_MS,
          to_ms: NOW_MS + 15 * 24 * HOUR_MS,
          measured_at_ms: NOW_MS,
          elapsed_percent: 50,
          usage: {
            from_ms: NOW_MS - 15 * 24 * HOUR_MS,
            to_ms: NOW_MS,
            requests: 2000,
            priced_requests: 1500,
            tokens: 200_000_000,
            cache_rate: 92.5,
            cost_nanos: 120_000_000_000,
          },
        },
        previous: {
          from_ms: NOW_MS - 45 * 24 * HOUR_MS,
          to_ms: NOW_MS - 15 * 24 * HOUR_MS,
          usage: {
            from_ms: NOW_MS - 45 * 24 * HOUR_MS,
            to_ms: NOW_MS - 15 * 24 * HOUR_MS,
            requests: 3500,
            priced_requests: 3500,
            tokens: 400_000_000,
            cache_rate: 94.0,
            cost_nanos: 260_000_000_000,
          },
        },
        projection: {
          basis: 'pace',
          sample_requests: 2000,
          sample_priced_requests: 1500,
          requests: 4000,
          tokens: 400_000_000,
          cost_nanos: 240_000_000_000,
          cache_rate: 92.5,
        },
      };
    });

    const view = renderWithOmc(
      <QuotaCapacityDialog
        open
        onClose={vi.fn()}
        owner={{ authIndex: 'codex-sub', credentialName: 'sa...6@gmail.com', subscriptionPeriodKey: `${NOW_MS - 15 * 24 * HOUR_MS}:${NOW_MS + 15 * 24 * HOUR_MS}:monthly` }}
        window={fiveHour}
        windows={[fiveHour, weekly]}
      />,
    );
    try {
      const dialog = await screen.findByRole('dialog');
      expect(subscriptionCalls).toBe(0);
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Subscription cycle' }));
      await waitFor(() => expect(subscriptionCalls).toBe(1));
      const lastCard = within(dialog).getByRole('region', { name: 'Last cycle' });
      const thisCard = within(dialog).getByRole('region', { name: 'This cycle' });
      const projectedCard = within(dialog).getByRole('region', { name: 'Projected total' });
      await waitFor(() => expect(thisCard.textContent).toContain('≥ $120.00'));
      expect(thisCard.textContent).toContain('50% elapsed');
      expect(lastCard.textContent).toContain('$260.00');
      expect(lastCard.textContent).toContain('Completed');
      expect(projectedCard.textContent).toContain('≥ $240.00');
      expect(projectedCard.textContent).toContain('4,000');
      expect(dialog.textContent).toContain('Tracks actual subscription-cycle usage');

      // A failed background refresh keeps the cached totals intact and surfaces the error note.
      failSubscription = true;
      await view.client.invalidateQueries({ queryKey: ['quota-subscription-cycle', 'codex-sub'] });
      await waitFor(() => expect(subscriptionCalls).toBe(2));
      await waitFor(() => expect(dialog.textContent).toContain('Could not load usage'));
      expect(thisCard.textContent).toContain('≥ $120.00');
      expect(lastCard.textContent).toContain('$260.00');
      expect(projectedCard.textContent).toContain('≥ $240.00');
    } finally { view.unmount(); }

    // Without verified subscription boundaries (e.g. Claude / Antigravity), the Subscription cycle tab is absent.
    const noSubView = renderWithOmc(
      <QuotaCapacityDialog
        open
        onClose={vi.fn()}
        owner={{ authIndex: 'codex-sub', credentialName: 'Claude Max', subscriptionPeriodKey: null }}
        window={fiveHour}
        windows={[fiveHour, weekly]}
      />,
    );
    try {
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByRole('radio', { name: 'Subscription cycle' })).toBeNull();
    } finally { noSubView.unmount(); }

    const groupWindow: QuotaWindow = {
      id: 'ag_Gemini_5h',
      label: 'Gemini Models \u00b7 Five Hour Limit',
      scope: 'group',
      kind: 'five_hour',
      remaining_percent: 80,
      reset_at_ms: NOW_MS + 3 * HOUR_MS,
    };
    api.on('GET', '/management/quota/ag-seat/capacity', () => ({ window_id: groupWindow.id, current: null, previous: null }));
    const groupView = renderWithOmc(
      <QuotaCapacityDialog open onClose={vi.fn()} owner={{ authIndex: 'ag-seat', credentialName: 'AG Ultra', subscriptionPeriodKey: null }} window={groupWindow} />,
    );
    try {
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByRole('radio', { name: 'Subscription cycle' })).toBeNull();
    } finally { groupView.unmount(); }
  });

  it('shows the drawer subscription-cycle trigger only for credentials with verified active billing dates', async () => {
    const api = installOmcApi();
    api.on('GET', '/management/quota/codex-verified/subscription-cycle', () => ({
      source: 'live_subscription',
      plan_label: 'Pro 200',
      current: {
        from_ms: NOW_MS - 10 * 24 * HOUR_MS,
        to_ms: NOW_MS + 20 * 24 * HOUR_MS,
        measured_at_ms: NOW_MS,
        elapsed_percent: 33,
        widened: true,
        usage: { from_ms: NOW_MS - 10 * 24 * HOUR_MS, to_ms: NOW_MS, requests: 120, priced_requests: 120, tokens: 8_000_000, cost_nanos: 18_500_000_000 },
      },
      previous: null,
      projection_unavailable: 'insufficient_elapsed',
    }));
    const verifiedItem = quota('codex-verified', [quotaWindow('five_hour', 100, 5)], {
      plan: {
        plan_type: 'pro',
        plan_label: 'Pro 200',
        tier: 'elite',
        starts_at_ms: NOW_MS - 10 * 24 * HOUR_MS,
        expires_at_ms: NOW_MS + 20 * 24 * HOUR_MS,
        expires_source: 'live_subscription',
      },
    });
    const view = renderWithOmc(
      <CredentialQuotaBody item={verifiedItem} credentialLabel="codex...example" nowMS={NOW_MS} isDemo={false} />,
    );
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Subscription cycle usage' }));
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getByRole('region', { name: 'This cycle' }).textContent).toContain('$18.50'));
      expect(within(dialog).getByRole('region', { name: 'Last cycle' }).textContent).toContain('No record of the last cycle yet');
      expect(within(dialog).getByRole('region', { name: 'Projected total' }).textContent).toContain('Cycle just started');
      expect(dialog.textContent).toContain('widened to whole buckets');
    } finally { view.unmount(); }

    // Claude / Antigravity without verified subscription start+expiry must not show the trigger.
    const antigravityItem = quota('ag-1', [{
      id: 'ag_Gemini_5h',
      label: 'Gemini Models \u00b7 Five Hour Limit',
      scope: 'group',
      kind: 'five_hour',
      remaining_percent: 80,
      reset_at_ms: NOW_MS + 3 * HOUR_MS,
    }], {
      provider: 'antigravity',
      type: 'antigravity',
      plan: { plan_type: 'ultra', plan_label: 'Ultra', tier: 'elite' },
    });
    const agView = renderWithOmc(
      <CredentialQuotaBody item={antigravityItem} credentialLabel="ag...example" nowMS={NOW_MS} isDemo={false} />,
    );
    try {
      expect(screen.queryByRole('button', { name: 'Subscription cycle usage' })).toBeNull();
    } finally { agView.unmount(); }
  });

  it('refreshes an open subscription-cycle dialog when the verified billing period rolls over while preserving same-period cache reuse', async () => {
    const api = installOmcApi();
    const DAY_MS = 24 * HOUR_MS;
    const period1Start = NOW_MS - 30 * DAY_MS;
    const period1End = NOW_MS + 1_000;
    const period2Start = period1End;
    const period2End = period2Start + 30 * DAY_MS;
    const period3Start = period2End;
    const period3End = period3Start + 30 * DAY_MS;

    const fiveHour: QuotaWindow = { ...quotaWindow('five_hour', 100, 5), period_hours: 5, capacity_unavailable: 'low_usage' };
    const weekly: QuotaWindow = { ...quotaWindow('weekly', 80, 100), period_hours: 168, capacity_unavailable: 'low_usage' };
    const subscriptionReads = () => api.requests.filter((req) => req.path === '/management/quota/codex-rollover/subscription-cycle').length;

    const makeSubscriptionPayload = (fromMS: number, toMS: number, measuredAtMS: number, costNanos: number, previousCostNanos?: number) => ({
      source: 'live_subscription' as const,
      plan_label: 'Pro 200',
      current: {
        from_ms: fromMS,
        to_ms: toMS,
        measured_at_ms: measuredAtMS,
        elapsed_percent: 5,
        usage: { from_ms: fromMS, to_ms: measuredAtMS, requests: 20, priced_requests: 20, tokens: 1_000_000, cost_nanos: costNanos },
      },
      previous: previousCostNanos == null
        ? null
        : {
          from_ms: fromMS - 30 * DAY_MS,
          to_ms: fromMS,
          usage: { from_ms: fromMS - 30 * DAY_MS, to_ms: fromMS, requests: 120, priced_requests: 120, tokens: 8_000_000, cost_nanos: previousCostNanos },
        },
      projection_unavailable: 'insufficient_elapsed' as const,
    });

    const makeItem = (startsAtMS: number, expiresAtMS: number) => quota('codex-rollover', [fiveHour, weekly], {
      plan: {
        plan_type: 'pro',
        plan_label: 'Pro 200',
        tier: 'elite',
        starts_at_ms: startsAtMS,
        expires_at_ms: expiresAtMS,
        billing_period: 'monthly',
        expires_source: 'live_subscription',
      },
    });

    let activePayload = makeSubscriptionPayload(period1Start, period1End, NOW_MS, 18_500_000_000);
    api.on('GET', '/management/quota/codex-rollover/subscription-cycle', () => activePayload);
    api.on('GET', '/management/quota/codex-rollover/capacity', (req) => ({
      window_id: req.query.get('window') ?? 'five_hour',
      current: null,
      previous: null,
    }));

    let setState!: React.Dispatch<React.SetStateAction<{ item: QuotaItem; nowMS: number }>>;
    const Host = () => {
      const [state, _setState] = React.useState(() => ({
        item: makeItem(period1Start, period1End),
        nowMS: NOW_MS,
      }));
      setState = _setState;
      return <CredentialQuotaBody item={state.item} credentialLabel="codex...rollover" nowMS={state.nowMS} isDemo={false} />;
    };

    const view = renderWithOmc(<Host />);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Subscription cycle usage' }));
      const dialog = await screen.findByRole('dialog');
      const thisCard = () => within(dialog).getByRole('region', { name: 'This cycle' });
      const lastCard = () => within(dialog).getByRole('region', { name: 'Last cycle' });

      await waitFor(() => expect(thisCard().textContent).toContain('$18.50'));
      expect(subscriptionReads()).toBe(1);

      // Keep the dialog open across rollover and hold the second fetch to verify the loading state
      // clears old totals immediately instead of labeling them as the new current cycle.
      const heldRollover = api.hold('GET', '/management/quota/codex-rollover/subscription-cycle');
      activePayload = makeSubscriptionPayload(period2Start, period2End, period2Start + 1_000, 2_000_000_000, 18_500_000_000);
      act(() => setState({ item: makeItem(period2Start, period2End), nowMS: period2Start + 1_000 }));

      await waitFor(() => expect(subscriptionReads()).toBe(2));
      expect(thisCard().getAttribute('aria-busy')).toBe('true');
      expect(thisCard().textContent).toContain('…');
      expect(thisCard().textContent).not.toContain('$18.50');

      heldRollover.release();
      await waitFor(() => {
        expect(thisCard().getAttribute('aria-busy')).toBeNull();
        expect(thisCard().textContent).toContain('$2.00');
      });
      expect(lastCard().textContent).toContain('$18.50');

      // Clock ticks within the same billing period do not re-fetch.
      act(() => setState((prev) => ({ ...prev, nowMS: period2Start + 16_000 })));
      expect(subscriptionReads()).toBe(2);

      // Switching tabs within the same billing period reuses the cached response.
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Weekly limit' }));
      await waitFor(() => expect(within(dialog).getByRole('region', { name: 'This window' })).toBeTruthy());
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Subscription cycle' }));
      await waitFor(() => expect(thisCard().textContent).toContain('$2.00'));
      expect(subscriptionReads()).toBe(2);

      // Closing and reopening within the same billing period also reuses the cache.
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Subscription cycle usage' }));
      const reopened = await screen.findByRole('dialog');
      await waitFor(() => expect(within(reopened).getByRole('region', { name: 'This cycle' }).textContent).toContain('$2.00'));
      expect(subscriptionReads()).toBe(2);

      // Crossing expiry before the refreshed snapshot arrives hides the stale subscription view
      // without issuing a request, then fetches Period 3 once verified dates land.
      act(() => setState((prev) => ({ ...prev, nowMS: period2End + 1_000 })));
      await waitFor(() => expect(within(reopened).queryByRole('radio', { name: 'Subscription cycle' })).toBeNull());
      expect(subscriptionReads()).toBe(2);

      activePayload = makeSubscriptionPayload(period3Start, period3End, period3Start + 1_000, 500_000_000, 2_000_000_000);
      act(() => setState({ item: makeItem(period3Start, period3End), nowMS: period3Start + 1_000 }));
      await waitFor(() => expect(subscriptionReads()).toBe(3));
      await waitFor(() => expect(within(reopened).getByRole('region', { name: 'This cycle' }).textContent).toContain('$0.50'));
    } finally { view.unmount(); }
  });
});

describe('dashboard model panels and heatmap alignment states', () => {
  it('omits the trend legend when models are empty and mounts it once models exist', async () => {
    const api = installOmcApi();
    let modelsPayload = {
      window: { from: NOW_MS - HOUR_MS, to: NOW_MS, bucket_ms: 60_000, minutes: 60 },
      total_tokens: 0,
      models: [] as Array<{
        model: string;
        tokens: number;
        requests: number;
        priced_requests: number;
        cost_usd: number | null;
        series: Array<{ t: number; tokens: number }>;
      }>,
    };
    api.on('GET', '/management/dashboard/models', () => modelsPayload);

    const view = renderWithOmc(
      <MemoryRouter>
        <ThemeProvider>
          <TokenDisplayProvider>
            <CurrencyDisplayProvider>
              <ModelPanelsProvider>
                <ModelTrendPanel query="preset=1h" range={{ preset: '1h' }} enabled />
                <ModelUsagePanel query="preset=1h" range={{ preset: '1h' }} enabled />
              </ModelPanelsProvider>
            </CurrencyDisplayProvider>
          </TokenDisplayProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );

    try {
      await waitFor(() => {
        expect(screen.getAllByText(makeT('en')('dash.models.empty'))).toHaveLength(2);
      });
      expect(screen.queryByTestId('model-trend-legend')).toBeNull();

      modelsPayload = {
        window: { from: NOW_MS - HOUR_MS, to: NOW_MS, bucket_ms: 60_000, minutes: 60 },
        total_tokens: 1200,
        models: [
          {
            model: 'gpt-5',
            tokens: 1200,
            requests: 4,
            priced_requests: 4,
            cost_usd: 0.12,
            series: [
              { t: NOW_MS - 120_000, tokens: 400 },
              { t: NOW_MS - 60_000, tokens: 800 },
            ],
          },
        ],
      };

      const nextView = renderWithOmc(
        <MemoryRouter>
          <ThemeProvider>
            <TokenDisplayProvider>
              <CurrencyDisplayProvider>
                <ModelPanelsProvider>
                  <ModelTrendPanel query="preset=24h" range={{ preset: '24h' }} enabled />
                  <ModelUsagePanel query="preset=24h" range={{ preset: '24h' }} enabled />
                </ModelPanelsProvider>
              </CurrencyDisplayProvider>
            </TokenDisplayProvider>
          </ThemeProvider>
        </MemoryRouter>,
      );

      try {
        const legend = await within(nextView.container).findByTestId('model-trend-legend');
        const toggle = within(legend).getByRole('button', { name: /gpt-5/ });
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
      } finally {
        nextView.unmount();
      }
    } finally {
      view.unmount();
    }
  });

  it('switches both cards to the client lens from the usage card title and back', async () => {
    const api = installOmcApi();
    const window = { from: NOW_MS - HOUR_MS, to: NOW_MS, bucket_ms: 60_000, minutes: 60 };
    const group = (model: string, extra: Record<string, unknown> = {}) => ({
      model, folded: false, tokens: 1200, requests: 4, priced_requests: 4, cost_usd: 0.12,
      series: [{ t: NOW_MS - 60_000, tokens: 1200 }], ...extra,
    });
    api.on('GET', '/management/dashboard/models', (request) => ({
      window,
      total_tokens: 1200,
      models: [
        request.query.get('group_by') === 'client' ? group('claude-code', { category: 'agent' }) : group('gpt-5'),
        group('', { folded: true }),
      ],
      partial_errors: [],
    }));
    const t = makeT('en');

    const view = renderWithOmc(
      <MemoryRouter>
        <ThemeProvider>
          <TokenDisplayProvider>
            <CurrencyDisplayProvider>
              <ModelPanelsProvider>
                <ModelTrendPanel query="preset=1h" range={{ preset: '1h' }} enabled />
                <ModelUsagePanel query="preset=1h" range={{ preset: '1h' }} enabled />
              </ModelPanelsProvider>
            </CurrencyDisplayProvider>
          </TokenDisplayProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    try {
      const legend = await screen.findByTestId('model-trend-legend');
      fireEvent.click(within(legend).getByRole('button', { name: /gpt-5/ }));
      expect(screen.getByRole('radiogroup', { name: t('dash.models.view_toggle_label') })).toBeTruthy();
      expect(view.container.querySelector('.model-usage-card [data-slot="panel-head-extra"]')).toBeNull();

      fireEvent.click(screen.getByRole('tab', { name: t('dash.models.lens_clients') }));
      // The model ranking stays on screen, and clickable, until the client one lands. A choice made
      // in it belongs to the models, even where the client ranking has a group of the same key.
      fireEvent.click(within(screen.getByTestId('model-trend-legend')).getByRole('button', { name: t('dash.models.folded') }));
      const clientEntry = await waitFor(() => within(screen.getByTestId('model-trend-legend')).getByRole('button', { name: /Claude Code/ }));
      expect(clientEntry.getAttribute('aria-pressed')).toBe('false');
      expect(within(screen.getByTestId('model-trend-legend')).getByRole('button', { name: t('dash.clients.folded') }).getAttribute('aria-pressed')).toBe('false');
      expect(screen.queryByRole('radiogroup', { name: t('dash.models.view_toggle_label') })).toBeNull();
      expect(api.requests.some((request) => request.query.get('group_by') === 'client')).toBe(true);

      fireEvent.click(screen.getByRole('tab', { name: t('dash.models.lens_models') }));
      await waitFor(() => expect(screen.getAllByText('gpt-5').length).toBeGreaterThan(0));
      expect(screen.getByRole('radiogroup', { name: t('dash.models.view_toggle_label') })).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it('speaks for the chosen lens when its read fails with no ranking held', async () => {
    const api = installOmcApi();
    api.on('GET', '/management/dashboard/models', () => {
      throw new Error('models unavailable');
    });
    const t = makeT('en');

    const view = renderWithOmc(
      <MemoryRouter>
        <ThemeProvider>
          <TokenDisplayProvider>
            <CurrencyDisplayProvider>
              <ModelPanelsProvider>
                <ModelUsagePanel query="preset=1h" range={{ preset: '1h' }} enabled />
              </ModelPanelsProvider>
            </CurrencyDisplayProvider>
          </TokenDisplayProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    try {
      await within(view.container).findByText(t('dash.models.error'));
      fireEvent.click(screen.getByRole('tab', { name: t('dash.models.lens_clients') }));
      await within(view.container).findByText(t('dash.clients.error'));
    } finally {
      view.unmount();
    }
  });

  it('keeps the heatmap header wrapper mounted when the first heatmap read fails', async () => {
    const api = installOmcApi();
    api.on('GET', '/management/dashboard/token-heatmap', () => {
      throw new Error('heatmap unavailable');
    });

    const view = renderWithOmc(
      <MemoryRouter>
        <ThemeProvider>
          <TokenDisplayProvider>
            <TokenHeatmap />
          </TokenDisplayProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );

    try {
      await within(view.container).findByText(makeT('en')('dash.heatmap.error'));
      expect(view.container.querySelector('.heatmap-inner > .heatmap-head')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});
