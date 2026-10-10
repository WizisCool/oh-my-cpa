import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import {
  CredentialQuotaPanel,
  type CredentialQuotaPanelProps,
} from '../src/components/dashboard/CredentialQuota';
import { buildCredentialQuotaBoard, credentialQuotaRefreshTargets } from '../src/components/dashboard/credentialQuotaLogic';
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
  it('orders credentials by what needs a decision first and only counts the disabled', () => {
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
    expect(low.windows.map((entry) => entry.kind)).toEqual(['five_hour', 'weekly']);
    expect(low.bindingWindow?.kind).toBe('weekly');
    expect(low.remainingPercent).toBe(12);
  });

  it('recovers an exhausted credential only when every spent window has reset', () => {
    const board = buildCredentialQuotaBoard(
      [file('spent')],
      [quota('spent', [quotaWindow('five_hour', 0, 2), quotaWindow('weekly', 0, 40)], { status: 'exhausted' })],
    );
    expect(board.rows[0]).toMatchObject({ state: 'exhausted', recoverAtMS: NOW_MS + 40 * HOUR_MS });
  });

  it('asks a live refresh only of enabled credentials a provider can be read for', () => {
    const quotas = [
      ...QUOTAS,
      quota('off', []),
      quota('unread', [], { capabilities: { refresh_supported: false, clear_cooldown_supported: false, reset_credit_supported: false } }),
    ];
    expect(credentialQuotaRefreshTargets(FILES, quotas)).toEqual(['ample', 'low', 'cooling', 'expired']);
    expect(credentialQuotaRefreshTargets([file('twin'), file('twin')], [quota('twin', [])])).toEqual([]);
  });
});

describe('credential quota presentation', () => {
  it('announces first loading without claiming an empty fleet', () => {
    render(<QuotaSurface isLoading />);
    expect(panelState()).toBe('loading');
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('No credential connected yet.')).toBeNull();
  });

  it('distinguishes an unread credential list from a deployment that holds none', () => {
    const retry = vi.fn();
    const { rerender } = render(<QuotaSurface isError error={new Error('read failed')} onRetry={retry} />);
    expect(panelState()).toBe('unknown');
    expect(screen.getByRole('alert').textContent).toContain('Failed to load credential quota');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<QuotaSurface files={[]} quotas={[]} />);
    expect(panelState()).toBe('empty');
    expect(screen.getByText('No credential connected yet.')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/omc/oauth-management?action=connect');
  });

  it('draws each credential with its windows or the reason it cannot serve', () => {
    render(<QuotaSurface files={FILES} quotas={QUOTAS} />);
    expect(panelState()).toBe('ready');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(5);

    expect(within(rows[0]).getByText('Sign-in required')).toBeTruthy();
    expect(within(rows[1]).getByText('Cooling down')).toBeTruthy();
    expect(rows[1].textContent).toContain('25m left');
    expect(within(rows[1]).queryByRole('meter')).toBeNull();

    const meters = within(rows[2]).getAllByRole('meter');
    expect(meters.map((meter) => meter.getAttribute('aria-valuenow'))).toEqual(['64', '12']);
    expect(rows[2].textContent).toContain('30h left');
    expect(within(rows[3]).getByText('ample@example.com')).toBeTruthy();
    expect(within(rows[4]).getByText('No quota reading')).toBeTruthy();

    // No row is interactive, and the footer is the panel's one way out.
    expect(screen.queryByRole('button')).toBeNull();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/omc/oauth-management');
    expect(links[0].closest('li')).toBeNull();
  });

  it('lists a large fleet in full, most urgent first, for the panel to scroll', () => {
    const files = Array.from({ length: 40 }, (_, index) => file(`credential-${index}`));
    const quotas = files.map((entry, index) => quota(entry.name, [quotaWindow('weekly', 100 - index, 24)]));
    render(<QuotaSurface files={files} quotas={quotas} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(40);
    expect(within(rows[0]).getByText('credential-39')).toBeTruthy();
    expect(within(rows[39]).getByText('credential-0')).toBeTruthy();
  });

  it('keeps the rows through a failed refresh and reports it additively', () => {
    const retry = vi.fn();
    const { rerender } = render(<QuotaSurface files={FILES} quotas={QUOTAS} isError onRetry={retry} />);
    expect(panelState()).toBe('ready');
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByRole('alert').classList.contains('ant-alert-warning')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<QuotaSurface files={FILES} quotas={QUOTAS} onRetry={retry} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers one control, which asks for fresh readings', () => {
    const refresh = vi.fn();
    const { rerender } = render(<QuotaSurface files={FILES} quotas={QUOTAS} onRefreshQuota={refresh} />);
    const button = screen.getByRole('button', { name: 'Refresh quota' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(button.getAttribute('aria-busy')).toBe('false');
    fireEvent.click(button);
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(<QuotaSurface files={FILES} quotas={QUOTAS} onRefreshQuota={refresh} isRefreshingQuota />);
    expect(screen.getByRole('button', { name: 'Refresh quota' }).getAttribute('aria-busy')).toBe('true');
  });

  it('still lists credentials when no quota reading is available', () => {
    render(<QuotaSurface files={[file('solo')]} />);
    expect(panelState()).toBe('ready');
    expect(screen.getByText('No quota reading')).toBeTruthy();
  });
});
