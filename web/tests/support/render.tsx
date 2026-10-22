import React from 'react';
import { App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../../src/i18n';

export interface RenderOptions {
  /** Wraps the tree in a router at this entry. */
  route?: string;
  /** Renders under React.StrictMode, which double-invokes effects as development does. */
  isStrict?: boolean;
  /** A client to share between mounts, so a remount can read what the first one cached. */
  client?: QueryClient;
}

const clients: QueryClient[] = [];

export function createTestQueryClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  return client;
}

/** Called by `setup.ts` after each test, once the tree has been unmounted. */
export function clearTestQueryClients() {
  for (const client of clients.splice(0)) client.clear();
}

/**
 * Renders inside the providers every console surface runs under: the query client, the
 * console's language and antd's App context. Each mount gets its own client unless one is
 * passed; every client is cleared after the test.
 */
export function renderWithOmc(ui: React.ReactNode, options: RenderOptions = {}): RenderResult & { client: QueryClient } {
  const client = options.client ?? createTestQueryClient();
  const routed = options.route === undefined ? ui : <MemoryRouter initialEntries={[options.route]}>{ui}</MemoryRouter>;
  const tree = <QueryClientProvider client={client}><I18nProvider><AntdApp>{routed}</AntdApp></I18nProvider></QueryClientProvider>;
  return { ...render(options.isStrict ? <React.StrictMode>{tree}</React.StrictMode> : tree), client };
}
