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
  const initialAuthFiles = [
    {
      id: 'auth-e2e-1', auth_index: 'auth-index-e2e-1', name: 'fixture-auth.json', type: 'codex', provider: 'codex',
      label: 'Primary fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      email: 'owner@example.test', account_type: 'oauth', account: FAKE_ACCOUNT_SECRET,
      id_token: { chatgpt_account_id: 'chatgpt-e2e-account', chatgpt_subscription_active_until: Math.floor((Date.now() + 24 * 86400000) / 1000), plan_type: 'pro' },
      success: 12, failed: 1, recent_requests: [{ time: '2026-09-01T12:00:00Z', success: 12, failed: 1 }],
      models: [{ id: 'gpt-e2e', display_name: 'GPT E2E' }], priority: 1, weight: 1, note: 'deterministic fixture',
    },
    {
      id: 'auth-e2e-2', auth_index: 'auth-index-e2e-2', name: 'claude-fixture.json', type: 'claude', provider: 'claude',
      label: 'Claude fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      success: 8, failed: 0, models: [{ id: 'claude-3-5-sonnet', display_name: 'Claude 3.5 Sonnet' }], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-3', auth_index: 'auth-index-e2e-3', name: 'antigravity-fixture.json', type: 'antigravity', provider: 'antigravity',
      project_id: 'e2e-project', label: 'Antigravity fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      success: 5, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-4', auth_index: 'auth-index-e2e-4', name: 'kimi-fixture.json', type: 'kimi', provider: 'kimi',
      label: 'Kimi fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      success: 3, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-5', auth_index: 'auth-index-e2e-5', name: 'xai-fixture.json', type: 'xai', provider: 'xai',
      label: 'xAI fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      success: 2, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-virtual', auth_index: 'auth-index-e2e-virtual', name: 'virtual-runtime.json', type: 'codex', provider: 'codex',
      label: 'Virtual fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: true,
      success: 0, failed: 0, models: [], priority: 0, weight: 1,
    },
  ];
  let authFiles = JSON.parse(JSON.stringify(initialAuthFiles));

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
      json(response, 200, { files: authFiles });
      return;
    }
    if (request.method === 'GET' && path === '/auth-files/models') {
      json(response, 200, { models: [{ id: 'gpt-e2e', display_name: 'GPT E2E' }] });
      return;
    }
    if (request.method === 'PATCH' && path === '/auth-files/status') {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      try { payload = JSON.parse(bodyText || '{}'); } catch {}
      const target = authFiles.find(f => f.name === payload.name);
      if (target) {
        target.disabled = Boolean(payload.disabled);
        target.status = payload.disabled ? 'disabled' : 'ok';
      }
      json(response, 200, { status: 'ok', disabled: payload.disabled });
      return;
    }
    if (request.method === 'PATCH' && path === '/auth-files/fields') {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      try { payload = JSON.parse(bodyText || '{}'); } catch {}
      const target = authFiles.find(f => f.name === payload.name);
      if (target) {
        if (payload.priority !== undefined) target.priority = payload.priority;
        if (payload.weight !== undefined) target.weight = payload.weight;
        if (payload.note !== undefined) target.note = payload.note;
      }
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'DELETE' && path === '/auth-files') {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let requestedNames = [];
      try {
        const parsed = JSON.parse(bodyText || '{}');
        requestedNames = parsed.names || (parsed.name ? [parsed.name] : []);
      } catch {}
      if (requestedNames.length === 0 && url.searchParams.get('name')) {
        requestedNames = [url.searchParams.get('name')];
      }
      const deletedFiles = [];
      const failed = [];
      for (const name of requestedNames) {
        if (name === 'fail-delete.json') {
          failed.push({ name, error: 'permission denied' });
          continue;
        }
        const idx = authFiles.findIndex(f => f.name === name);
        if (idx >= 0) {
          authFiles.splice(idx, 1);
          deletedFiles.push(name);
        } else {
          failed.push({ name, error: 'file not found' });
        }
      }
      if (failed.length > 0) {
        json(response, 207, { status: 'partial', deleted: deletedFiles.length, files: deletedFiles, failed });
        return;
      }
      if (requestedNames.length === 1) {
        json(response, 200, { status: 'ok' });
        return;
      }
      json(response, 200, { status: 'ok', deleted: deletedFiles.length, files: deletedFiles });
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
      json(response, 200, { url: 'https://auth.example.test/oauth?session=e2e', state: 'e2e-state' });
      return;
    }
    if (request.method === 'GET' && path === '/get-auth-status') {
      const state = url.searchParams.get('state') || url.searchParams.get('session_id') || '';
      // Sessions whose browser auto-callback already finished report
      // completed, so the facade idempotency path is exercisable in E2E.
      if (state === 'already-done') {
        json(response, 200, { status: 'ok' });
        return;
      }
      json(response, 200, { status: 'wait', message: 'waiting for user' });
      return;
    }
    if (request.method === 'DELETE' && path === '/oauth-session') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && path === '/oauth-callback') {
      let state = '';
      try {
        const body = JSON.parse(requests[requests.length - 1].body || '{}');
        state = new URL(body.redirect_url || '', 'http://placeholder.local').searchParams.get('state') || '';
      } catch { /* keep state empty */ }
      // Simulate the CPA auto-callback race: a repeated manual submission
      // for an already-completed session answers 409.
      if (state === 'already-done') {
        json(response, 409, { status: 'error', error: 'oauth flow is already completed' });
        return;
      }
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && path === '/reset-quota') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && path === '/api-call') {
      let body = {};
      try {
        body = JSON.parse(requests[requests.length - 1].body || '{}');
      } catch {}
      const targetURL = body.url || '';
      if (targetURL.includes('rate-limit-reset-credits/consume') || targetURL.includes('reset_credits/consume')) {
        json(response, 200, { status_code: 200, header: { 'content-type': ['application/json'] }, body: { status: 'ok' } });
        return;
      }
      if (targetURL.includes('rate-limit-reset-credits')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            available_count: 2,
            applicable_available_count: 1,
            credits: [
              { id: 'credit-1', status: 'available', reset_type: 'codex_rate_limits', granted_at: String(Date.now() - 86400000), expires_at: String(Date.now() + 28 * 86400000) },
              { id: 'credit-2', status: 'available', reset_type: 'codex_rate_limits', granted_at: String(Date.now() - 86400000), expires_at: String(Date.now() + 29 * 86400000) },
              { id: 'credit-3', status: 'used', reset_type: 'codex_rate_limits', granted_at: String(Date.now() - 3 * 86400000), expires_at: String(Date.now() + 2 * 86400000) },
            ],
          },
        });
        return;
      }
      if (targetURL.includes('backend-api/wham/usage')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            plan_type: 'pro',
            rate_limit: {
              primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 7200 },
              secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_after_seconds: 172800 },
            },
            rate_limit_reset_credits: { available_count: 2, applicable_available_count: 1 },
          },
        });
        return;
      }
      if (targetURL.includes('oauth/usage')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            five_hour: { utilization: 20.0, resets_at: new Date(Date.now() + 7200000).toISOString() },
            seven_day: { utilization: 50.0, resets_at: new Date(Date.now() + 86400000).toISOString() },
          },
        });
        return;
      }
      if (targetURL.includes('oauth/profile')) {
        json(response, 200, { status_code: 200, header: { 'content-type': ['application/json'] }, body: { account: { has_claude_pro: true } } });
        return;
      }
      if (targetURL.includes('retrieveUserQuotaSummary')) {
        // Mirrors the real antigravity summary: two groups, weekly bucket listed
        // before the five-hour one, display names like "Five Hour Limit".
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            groups: [
              { displayName: 'Gemini Models', buckets: [
                { bucketId: 'gemini-week', displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 0.51, resetTime: new Date(Date.now() + 5.5 * 86400000).toISOString() },
                { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', window: '5h', remainingFraction: 1.0, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() },
              ] },
              { displayName: 'Claude and GPT models', buckets: [
                { bucketId: 'aerolith-week', displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 1.0, resetTime: new Date(Date.now() + 7 * 86400000).toISOString() },
                { bucketId: 'aerolith-5h', displayName: 'Five Hour Limit', window: '5h', remainingFraction: 1.0, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() },
              ] },
            ],
          },
        });
        return;
      }
      if (targetURL.includes('coding/v1/usages')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            limits: [{ name: 'daily', title: 'Daily limit', used: 15, limit: 100 }],
          },
        });
        return;
      }
      if (targetURL.includes('cli-chat-proxy.grok.com') || targetURL.includes('x.ai')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            config: { credit_usage_percent: 30.0, monthly_limit: 10000, used: 3000 },
          },
        });
        return;
      }
      json(response, 200, { status_code: 200, header: {}, body: {} });
      return;
    }
    if (request.method === 'GET' && path === '/plugins') {
      json(response, 200, { plugins: [
        {
          id: 'fixture-logger',
          name: 'Request Logger Plugin',
          description: 'Audits and logs request metadata to internal store',
          version: '1.0.0',
          author: 'cpa-official',
          enabled: true,
          permissions: ['read_request', 'write_log'],
          config: { level: 'info' }
        },
        {
          id: 'iflow-auth',
          name: 'iFlow Alliance Auth',
          description: 'iFlow alliance OAuth login plugin',
          version: '1.0.0',
          author: 'cpa-official',
          enabled: true,
          effective_enabled: true,
          registered: true,
          supports_oauth: true,
          oauth_provider: 'iflow',
          logo: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%234F46E5'/%3E%3Ctext x='12' y='16' font-size='9' font-family='monospace' fill='white' text-anchor='middle'%3EiF%3C/text%3E%3C/svg%3E",
          permissions: ['oauth'],
        },
      ] });
      return;
    }
    if (request.method === 'GET' && path === '/plugin-store') {
      json(response, 200, { plugins: [{
        id: 'fixture-limiter',
        name: 'Rate Limiter',
        description: 'In-memory client token-bucket rate limiter',
        version: '1.2.0',
        author: 'cpa-community',
        permissions: ['inspect_client_ip', 'enforce_limit'],
        installed: false
      }, {
        id: 'fixture-logger',
        name: 'Request Logger Plugin',
        description: 'Audits and logs request metadata to internal store',
        version: '1.0.0',
        author: 'cpa-official',
        permissions: ['read_request', 'write_log'],
        installed: true
      }] });
      return;
    }
    if ((request.method === 'POST' || request.method === 'PATCH' || request.method === 'PUT' || request.method === 'DELETE') && (path.startsWith('/plugins') || path.startsWith('/plugin-store'))) {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && ['/api-keys', '/claude-api-key', '/gemini-api-key', '/oauth-excluded-models'].includes(path)) {
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
