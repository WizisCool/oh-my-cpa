import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadFailure, Notice } from '../src/components/feedback';
import { I18nProvider } from '../src/i18n';

describe('Notice', () => {
  beforeEach(() => { window.localStorage.setItem('omc-lang', 'en'); });

  it('names its tone as a status code above the headline and its detail', () => {
    render(<I18nProvider><Notice tone="warning" title="Plugins are off" description="Installed plugins do not run." /></I18nProvider>);
    const notice = screen.getByRole('alert');

    expect(notice.classList.contains('is-warning')).toBe(true);
    expect(notice.textContent).toBe('WARNINGPlugins are offInstalled plugins do not run.');
  });

  it('promotes a lone description to the headline', () => {
    render(<I18nProvider><Notice tone="info" description="Unsaved rules stay in this tab." /></I18nProvider>);

    expect(screen.getByRole('alert').querySelector('.omc-notice-title')?.textContent).toBe('Unsaved rules stay in this tab.');
    expect(screen.getByRole('alert').querySelector('.omc-notice-detail')).toBeNull();
  });

  it('offers a close control only when the condition may be put away', () => {
    const onClose = vi.fn();
    const { rerender } = render(<I18nProvider><Notice tone="error" title="Refused" /></I18nProvider>);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

    rerender(<I18nProvider><Notice tone="error" title="Refused" onClose={onClose} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('carries a failed read with its reason and its retry', () => {
    const onRetry = vi.fn();
    render(<I18nProvider><LoadFailure title="Quota could not be read" error={new Error('upstream timed out')} onRetry={onRetry} /></I18nProvider>);
    const failure = screen.getByRole('alert');

    expect(failure.classList.contains('is-error')).toBe(true);
    expect(failure.textContent).toContain('upstream timed out');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
