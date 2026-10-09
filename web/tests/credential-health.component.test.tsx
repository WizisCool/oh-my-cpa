import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import { CredentialHealth, type CredentialHealthProps } from '../src/components/dashboard/CredentialHealth';
import type { ManagementOverview } from '../src/types/management';

const OVERVIEW: ManagementOverview = {
  status: 'degraded',
  cpa_connected: true,
  counts: { management_keys: 1, provider_keys: 0, credentials: 9, models: null },
  traffic: null,
  providers: [],
  credentials: {
    total: 9,
    active: 7,
    unavailable: 1,
    disabled: 1,
    by_type: [
      { type: 'codex', count: 4, disabled: 1 },
      { type: 'claude', count: 5, disabled: 0 },
    ],
  },
  partial_errors: ['api-key-usage: CPA unavailable'],
};

function HealthSurface(props: CredentialHealthProps) {
  return <React.StrictMode><MemoryRouter basename="/omc" initialEntries={['/omc/dashboard']}>
    <I18nProvider><CredentialHealth {...props} /></I18nProvider>
  </MemoryRouter></React.StrictMode>;
}

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
});

describe('credential health presentation', () => {
  it('announces first loading without claiming empty credentials', () => {
    render(<HealthSurface isLoading />);
    expect(screen.getByTestId('dashboard-credential-health').getAttribute('data-health-state')).toBe('loading');
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.queryByText('No auth file data yet.')).toBeNull();
  });

  it('distinguishes an unread health projection from a successful empty fleet', () => {
    const retry = vi.fn();
    const { rerender } = render(<HealthSurface overview={{ ...OVERVIEW, credentials: null }} onRetry={retry} />);
    expect(screen.getByTestId('dashboard-credential-health').getAttribute('data-health-state')).toBe('unknown');
    expect(screen.getByText('Credential health data unavailable.')).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.queryByText('No auth file data yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<HealthSurface overview={{ ...OVERVIEW, credentials: { total: 0, active: 0, unavailable: 0, disabled: 0, by_type: [] } }} />);
    expect(screen.getByTestId('dashboard-credential-health').getAttribute('data-health-state')).toBe('empty');
    expect(screen.getByText('No auth file data yet.')).toBeTruthy();
    expect(screen.queryByText('Credential health data unavailable.')).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('renders measured counts and keeps the credential link within the deployment basename', () => {
    render(<HealthSurface overview={OVERVIEW} />);
    expect(screen.getByTestId('dashboard-credential-health').getAttribute('data-health-state')).toBe('ready');
    const meter = screen.getByRole('meter', { name: 'Credential health' });
    expect(meter.getAttribute('aria-valuemin')).toBe('0');
    expect(meter.getAttribute('aria-valuemax')).toBe('9');
    expect(meter.getAttribute('aria-valuenow')).toBe('7');
    expect(meter.querySelector<HTMLElement>('.health-active')?.style.flexGrow).toBe('7');
    expect(meter.querySelector<HTMLElement>('.health-unavailable')?.style.flexGrow).toBe('1');
    expect(meter.querySelector<HTMLElement>('.health-disabled')?.style.flexGrow).toBe('1');
    expect(screen.getByText('codex').textContent).toMatch(/4/);
    expect(screen.getByText('claude').textContent).toMatch(/5/);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/omc/oauth-management');
  });

  it('offers retry for a failed first read and recovers to measured health', () => {
    const retry = vi.fn();
    const { rerender } = render(<HealthSurface isError error={new Error('read failed')} onRetry={retry} />);
    expect(screen.getByTestId('dashboard-credential-health').getAttribute('data-health-state')).toBe('unknown');
    expect(screen.getByRole('alert').textContent).toContain('Failed to load credential health');
    expect(screen.queryByRole('meter')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<HealthSurface overview={OVERVIEW} onRetry={retry} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('7');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains the measured fleet during refresh and exposes a failed refresh additively', () => {
    const retry = vi.fn();
    const { rerender } = render(<HealthSurface overview={OVERVIEW} isLoading onRetry={retry} />);
    expect(screen.getByTestId('dashboard-credential-health').getAttribute('data-health-state')).toBe('ready');
    expect(screen.getByRole('meter')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<HealthSurface overview={OVERVIEW} isError error={new Error('refresh failed')} onRetry={retry} />);
    expect(screen.getByTestId('dashboard-credential-health').getAttribute('data-health-state')).toBe('ready');
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('7');
    expect(screen.getByRole('alert').classList.contains('ant-alert-warning')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<HealthSurface overview={{ ...OVERVIEW, credentials: { ...OVERVIEW.credentials!, active: 8, unavailable: 0 } }} onRetry={retry} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('8');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
