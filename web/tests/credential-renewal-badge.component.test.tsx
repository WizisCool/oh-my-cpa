import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { CredentialRenewalBadge } from '../src/components/authFiles/CredentialRenewalBadge';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';

function makeFile(overrides: Partial<ManagementAuthFile> = {}): ManagementAuthFile {
  return {
    name: 'test-credential',
    auth_index: 'auth-1',
    disabled: false,
    unavailable: false,
    runtime_only: false,
    success: 0,
    failed: 0,
    recovery_supported: true,
    ...overrides,
  };
}

function renderBadge(file: ManagementAuthFile, onOpen?: () => void) {
  return render(
    <I18nProvider>
      <CredentialRenewalBadge file={file} onOpen={onOpen} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
});

describe('CredentialRenewalBadge', () => {
  it('remains silent for healthy verified renewal to preserve visual calm', () => {
    const onOpen = vi.fn();
    const file = makeFile({
      renewal_state: 'renewal_verified',
      access_token_expires_at: '2026-10-15T12:00:00Z',
      next_refresh_after: '2026-10-14T12:00:00Z',
    });
    const { container } = renderBadge(file, onOpen);
    expect(screen.queryByTestId('oauth-credential-renewal-badge')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('remains silent for awaiting first renewal state', () => {
    const file = makeFile({
      renewal_state: 'awaiting_first_renewal',
    });
    const { container } = renderBadge(file);
    expect(screen.queryByTestId('oauth-credential-renewal-badge')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('remains silent when recovery is unsupported', () => {
    const file = makeFile({
      recovery_supported: false,
    });
    const { container } = renderBadge(file);
    expect(screen.queryByTestId('oauth-credential-renewal-badge')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders warning alert icon and invokes onOpen when retry is scheduled', () => {
    const onOpen = vi.fn();
    const file = makeFile({
      renewal_state: 'retry_scheduled',
      refresh_error: { code: 'cpa_timeout', http_status: 504 },
    });
    renderBadge(file, onOpen);

    const badge = screen.getByTestId('oauth-credential-renewal-badge');
    expect(badge).toBeTruthy();
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.getAttribute('aria-label')).toBe('Automatic renewal: Retry scheduled');
    expect(badge.getAttribute('data-renewal-state')).toBe('retry_scheduled');
    expect(badge.getAttribute('data-renewal-kind')).toBe('retry');
    expect(badge.getAttribute('data-renewal-tone')).toBe('warn');

    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders danger alert icon when sign-in is required', () => {
    const file = makeFile({
      requires_sign_in: true,
      renewal_state: 'sign_in_required',
    });
    renderBadge(file);

    const badge = screen.getByTestId('oauth-credential-renewal-badge');
    expect(badge.getAttribute('aria-label')).toBe('Automatic renewal: Sign-in required');
    expect(badge.getAttribute('data-renewal-state')).toBe('sign_in_required');
    expect(badge.getAttribute('data-renewal-kind')).toBe('reauth');
    expect(badge.getAttribute('data-renewal-tone')).toBe('danger');
  });

  it('renders static span element when onOpen is omitted on an alert state', () => {
    const file = makeFile({
      renewal_state: 'retry_scheduled',
    });
    renderBadge(file);

    const badge = screen.getByTestId('oauth-credential-renewal-badge');
    expect(badge.tagName).toBe('SPAN');
    expect(badge.getAttribute('role')).toBe('img');
  });
});
