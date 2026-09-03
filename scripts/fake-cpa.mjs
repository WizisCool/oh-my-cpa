import http from 'node:http';

export const FAKE_CPA_MANAGEMENT_KEY = 'omc-e2e-management-key';
export const FAKE_PROVIDER_SECRET = 'omc-e2e-provider-secret';
export const FAKE_ACCOUNT_SECRET = 'omc-e2e-account-secret';

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'X-CPA-Version': '7.2.146-e2e', ...headers });
  response.end(JSON.stringify(body));
}

export function createFakeCpaServer({ managementKey = FAKE_CPA_MANAGEMENT_KEY } = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake-cpa.local');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: url.pathname, query: url.search, body: Buffer.concat(chunks).toString('utf8') });

    if (request.headers.authorization !== `Bearer ${managementKey}`) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    const path = url.pathname.replace(/^\/v0\/management/, '');

    if (request.method === 'GET' && path === '/auth-files') {
      json(response, 200, { files: [{
        id: 'auth-e2e-1', auth_index: 'auth-index-e2e-1', name: 'fixture-auth.json', type: 'codex', provider: 'codex',
        label: 'Primary fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
        email: 'owner@example.test', account_type: 'oauth', account: FAKE_ACCOUNT_SECRET,
        success: 12, failed: 1, recent_requests: [{ time: '2026-09-01T12:00:00Z', success: 12, failed: 1 }],
        models: [{ id: 'gpt-e2e', display_name: 'GPT E2E' }], priority: 1, weight: 1, note: 'deterministic fixture',
      }] });
      return;
    }
    if (request.method === 'GET' && path === '/auth-files/models') {
      json(response, 200, { models: [{ id: 'gpt-e2e', display_name: 'GPT E2E' }] });
      return;
    }
    if (request.method === 'GET' && path === '/config') {
      json(response, 200, {
        host: '127.0.0.1', port: 8317, debug: false, 'proxy-url': '', 'request-log': true,
        'logging-to-file': true, 'usage-statistics-enabled': true, 'request-retry': 3,
        'max-retry-interval': 30, 'max-retry-credentials': 2, 'ws-auth': true,
        'force-model-prefix': false, 'logs-max-total-size-mb': 100, 'error-logs-max-files': 5,
        routing: { strategy: 'least-load' }, 'api-keys': ['fixture-client-key'],
        'codex-api-key': [{ 'api-key': FAKE_PROVIDER_SECRET, 'auth-index': 'codex-e2e', 'base-url': 'https://provider.example.test', models: [{ name: 'gpt-e2e', alias: 'gpt-e2e' }] }],
        'openai-compatibility': [],
      });
      return;
    }
    if (request.method === 'GET' && path === '/config.yaml') {
      response.writeHead(200, { 'Content-Type': 'application/yaml', 'X-CPA-Version': '7.2.146-e2e' });
      response.end('host: 127.0.0.1\nport: 8317\ndebug: false\nlogging-to-file: true\nrequest-log: true\n');
      return;
    }
    if (request.method === 'GET' && path === '/codex-api-key') {
      json(response, 200, { 'codex-api-key': [{ 'api-key': FAKE_PROVIDER_SECRET, 'auth-index': 'codex-e2e', 'base-url': 'https://provider.example.test', models: [{ name: 'gpt-e2e', alias: 'gpt-e2e' }] }] });
      return;
    }
    if (request.method === 'GET' && path === '/openai-compatibility') {
      json(response, 200, { 'openai-compatibility': [] });
      return;
    }
    if (request.method === 'GET' && path === '/api-key-usage') {
      json(response, 200, { codex: { [`https://provider.example.test|${FAKE_PROVIDER_SECRET}`]: { success: 12, failed: 1, recent_requests: [{ time: '2026-09-01T12:00:00Z', success: 12, failed: 1 }] } } });
      return;
    }
    if (request.method === 'GET' && path === '/logs') {
      json(response, 200, { lines: ['2026-09-01T12:00:00Z INFO fixture request completed'], 'latest-timestamp': 1788264000, 'next-cursor': 'fixture-cursor' });
      return;
    }
    if (request.method === 'GET' && path === '/logs/status') {
      json(response, 404, { error: 'not found' });
      return;
    }
    if (request.method === 'GET' && path === '/request-error-logs') {
      json(response, 200, { files: [] });
      return;
    }
    if (request.method === 'GET' && path === '/latest-version') {
      json(response, 200, { version: '7.2.146-e2e' });
      return;
    }
    if (request.method === 'GET' && path.endsWith('-auth-url')) {
      json(response, 200, { url: 'https://auth.example.test/oauth?session=e2e' });
      return;
    }
    if (request.method === 'GET' && path === '/get-auth-status') {
      json(response, 200, { status: 'waiting', message: 'waiting for user' });
      return;
    }
    if (request.method === 'DELETE' && path === '/oauth-session') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && path === '/oauth-callback') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && path === '/reset-quota') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && ['/api-keys', '/claude-api-key', '/gemini-api-key', '/oauth-excluded-models', '/plugins', '/plugin-store'].includes(path)) {
      json(response, 200, {});
      return;
    }
    if (request.method === 'PUT' && (path === '/config.yaml' || path.startsWith('/'))) {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'DELETE' && path === '/logs') {
      json(response, 200, { status: 'ok' });
      return;
    }
    json(response, 404, { error: 'not found' });
  });
  return { server, requests };
}
