/**
 * How an external agent reaches this console over MCP, as text the operator copies.
 *
 * Pure, so the snippets can be asserted without a browser: a wrong flag or a mangled URL here is
 * a guide that reads fine and fails in someone's terminal.
 */

/** The environment variable every snippet reads the management key from, matching the stdio bridge. */
export const MANAGEMENT_KEY_VARIABLE = 'OMCPA_CPA_MANAGEMENT_KEY';

export const CONNECT_CLIENTS = ['claude', 'codex', 'other', 'stdio'] as const;
export type ConnectClient = typeof CONNECT_CLIENTS[number];

/** The console address an agent is given: where this page was loaded from, base path included. */
export function consoleUrl(origin: string, basePath: string): string {
  return `${origin.replace(/\/+$/, '')}${basePath === '/' ? '' : basePath.replace(/\/+$/, '')}`;
}

export function mcpEndpoint(origin: string, basePath: string): string {
  return `${consoleUrl(origin, basePath)}/api/mcp`;
}

/**
 * Whether the management key would cross a network unencrypted. Loopback is exempt for the same
 * reason the stdio bridge accepts plain HTTP there: the traffic never leaves the machine.
 */
export function isInsecureOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return !(host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host));
}

export interface ConnectSnippet {
  /** The fence language the block is highlighted as. */
  lang: 'bash' | 'toml' | 'json';
  code: string;
}

/**
 * One client's configuration.
 *
 * Where the client can read the key from the environment, the snippet names the variable rather
 * than leaving a slot for the key itself, so the secret is not pasted into a file or a shell
 * history. `keyPlaceholder` fills the slot where a client only accepts a literal.
 */
export function connectSnippet(client: ConnectClient, origin: string, basePath: string, keyPlaceholder: string): ConnectSnippet {
  const endpoint = mcpEndpoint(origin, basePath);
  switch (client) {
    case 'claude':
      return {
        lang: 'bash',
        code: `claude mcp add --transport http oh-my-cpa ${endpoint} \\\n  --header "Authorization: Bearer $${MANAGEMENT_KEY_VARIABLE}"`,
      };
    case 'codex':
      return {
        lang: 'toml',
        code: `[mcp_servers.oh-my-cpa]\nurl = "${endpoint}"\nbearer_token_env_var = "${MANAGEMENT_KEY_VARIABLE}"`,
      };
    case 'other':
      return {
        lang: 'json',
        code: JSON.stringify({
          mcpServers: { 'oh-my-cpa': { url: endpoint, headers: { Authorization: `Bearer <${keyPlaceholder}>` } } },
        }, null, 2),
      };
    case 'stdio':
      return {
        lang: 'json',
        code: JSON.stringify({
          mcpServers: {
            'oh-my-cpa': {
              command: '/path/to/oh-my-cpa',
              args: ['mcp'],
              env: { OMCPA_SERVER_URL: consoleUrl(origin, basePath), [MANAGEMENT_KEY_VARIABLE]: `<${keyPlaceholder}>` },
            },
          },
        }, null, 2),
      };
  }
}

/** The operation an approval link names, or '' when the query carries none worth asking the server about. */
export function linkedOperationID(search: string): string {
  const id = new URLSearchParams(search).get('operation') ?? '';
  return /^[0-9a-f]{48}$/.test(id) ? id : '';
}
