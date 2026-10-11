import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogFileViewer } from '../src/components/logs/LogFileViewer';
import { I18nProvider } from '../src/i18n';
import { MAX_LOG_PREVIEW_BYTES, type LogViewerTarget } from '../src/types/logs';

const REFUSED_LOG = '=== REQUEST INFO ===\nURL: /v1/messages\n\n=== RESPONSE ===\nStatus: 503\nauth_unavailable: no auth available\n';

function Surface({ target, onClose = () => {} }: { target: LogViewerTarget | null; onClose?: () => void }) {
  const [client] = React.useState(() => new QueryClient());
  return (
    <React.StrictMode>
      <QueryClientProvider client={client}>
        <I18nProvider><LogFileViewer target={target} onClose={onClose} /></I18nProvider>
      </QueryClientProvider>
    </React.StrictMode>
  );
}

/** Answers every read with one response and records the paths that were asked for. */
function stubLogRead(respond: () => Response): string[] {
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    paths.push(new URL(String(input), 'http://console.test').pathname);
    return respond();
  }));
  return paths;
}

const downloadButton = () => screen.getByRole('button', { name: /Download/ }) as HTMLButtonElement;
const copyButton = () => screen.getByRole('button', { name: /Copy/ }) as HTMLButtonElement;

describe('LogFileViewer', () => {
  beforeEach(() => {
    window.localStorage.setItem('omc-lang', 'en');
    window.__OMCPA_CONFIG__ = { apiBaseUrl: '/omc/api/v1' } as typeof window.__OMCPA_CONFIG__;
  });

  it('reads a request log by the id on its gateway line and titles it as that file', async () => {
    const paths = stubLogRead(() => new Response(REFUSED_LOG, { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    render(<Surface target={{ kind: 'request', requestId: '41dbb9ee' }} />);

    expect((await screen.findByText(/auth_unavailable: no auth available/)).tagName).toBe('PRE');
    expect(screen.getByText('request-41dbb9ee.log')).toBeTruthy();
    expect(new Set(paths)).toEqual(new Set(['/omc/api/v1/management/request-logs/41dbb9ee']));
    expect(downloadButton().disabled).toBe(false);
    expect(copyButton().disabled).toBe(false);
  });

  it('reads a named error log from the error-log route', async () => {
    const paths = stubLogRead(() => new Response(REFUSED_LOG, { status: 200 }));
    render(<Surface target={{ kind: 'file', file: { name: 'error-v1-messages-41dbb9ee.log', size: 1622, modified: 0 } }} />);

    await screen.findByText(/auth_unavailable/);
    expect(new Set(paths)).toEqual(new Set(['/omc/api/v1/management/request-error-logs/error-v1-messages-41dbb9ee.log']));
  });

  it('words a file CPA did not keep as retention, with nothing to retry, copy or save', async () => {
    stubLogRead(() => new Response(
      JSON.stringify({ error: 'CPA holds no log file for this request', code: 'request_log_not_found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    ));
    render(<Surface target={{ kind: 'request', requestId: 'deadbeef' }} />);

    const notice = await screen.findByRole('alert');
    expect(notice.classList.contains('is-warning')).toBe(true);
    expect(notice.textContent).toContain('CPA holds no log file for this request');
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(downloadButton().disabled).toBe(true);
    expect(copyButton().disabled).toBe(true);
  });

  it('reports any other failed read as a failure that can be retried', async () => {
    stubLogRead(() => new Response(JSON.stringify({ error: 'CPA is unreachable' }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
    render(<Surface target={{ kind: 'request', requestId: '41dbb9ee' }} />);

    const failure = await screen.findByRole('alert');
    expect(failure.classList.contains('is-error')).toBe(true);
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });

  it('offers a file past the preview limit as a download instead of drawing it', async () => {
    stubLogRead(() => new Response('x'.repeat(MAX_LOG_PREVIEW_BYTES + 1), { status: 200 }));
    render(<Surface target={{ kind: 'request', requestId: '41dbb9ee' }} />);

    expect((await screen.findByRole('alert')).textContent).toContain('larger than');
    expect(document.querySelector('pre')).toBeNull();
    expect(downloadButton().disabled).toBe(false);
    expect(copyButton().disabled).toBe(true);
  });

  it('asks for nothing while closed and dismisses through its close control', async () => {
    const paths = stubLogRead(() => new Response(REFUSED_LOG, { status: 200 }));
    const onClose = vi.fn();
    const { rerender } = render(<Surface target={null} onClose={onClose} />);
    expect(paths).toEqual([]);

    rerender(<Surface target={{ kind: 'request', requestId: '41dbb9ee' }} onClose={onClose} />);
    await screen.findByText(/auth_unavailable/);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
