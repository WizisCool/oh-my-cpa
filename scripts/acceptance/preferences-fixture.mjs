import contract from './contracts/preferences.json' with { type: 'json' };

export const PREFERENCE_CONTRACT = contract;

/** One store per context; the shared wire corpus is independently checked by Go. */
export function createPreferenceFixture({ serverTimezone = PREFERENCE_CONTRACT.server_timezone, authenticated = true } = {}) {
  const preferences = Object.create(null);
  const knownKeys = new Set(PREFERENCE_CONTRACT.known_keys);
  return (url, method, body) => {
    if (!authenticated) return { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' }, json: { error: 'authentication required' } };
    const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
    const respond = (status, json) => ({ status, headers, json });
    if (method === 'GET' && url.pathname.endsWith('/preferences')) {
      const timezone = preferences.omc_timezone ?? '';
      return respond(200, { preferences: structuredClone({ ...preferences }), time_zone: {
        timezone, server_timezone: serverTimezone, effective_timezone: timezone || serverTimezone,
      } });
    }
    if (method !== 'PUT' || !url.pathname.includes('/preferences/')) throw new Error(`Unsupported preference fixture route: ${method} ${url.pathname}`);
    const key = decodeURIComponent(url.pathname.split('/').pop());
    if (!knownKeys.has(key)) return respond(400, { error: 'unsupported preference key' });
    let value;
    try { value = JSON.parse(body); }
    catch { return respond(400, { error: 'preference value must be a JSON document' }); }
    if (key === 'omc_timezone') {
      if (typeof value !== 'string') return respond(400, { error: 'invalid_timezone' });
      if (value !== '') {
        try { new Intl.DateTimeFormat('en', { timeZone: value }); }
        catch { return respond(400, { error: 'invalid_timezone' }); }
      }
    }
    if (key === 'omc_quota_auto_refresh' && !isQuotaAutoRefreshDocument(value)) return respond(400, { error: 'invalid_quota_auto_refresh' });
    // Credential/custom-icon reference validation remains in Go and each relevant
    // scenario. This fixture models the JSON/timezone preference wire boundary,
    // not a second repository or an assertion that every valid JSON is admissible.
    preferences[key] = value;
    return respond(200, { key, value: structuredClone(value) });
  };
}

/** The server's strict shape for the automatic quota refresh policy (`quota.ParseAutoRefreshSettings`). */
function isQuotaAutoRefreshDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'interval_minutes' || keys[1] !== 'refresh_on_reset') return false;
  const minutes = value.interval_minutes;
  return Number.isInteger(minutes) && (minutes === 0 || (minutes >= 5 && minutes <= 1440)) && typeof value.refresh_on_reset === 'boolean';
}
