import contract from './contracts/warmup.json' with { type: 'json' };
export const WARMUP_CONTRACT = contract;

/** A bounded projection fixture; Go certifies the wire shape and refusal cases. */
export function createWarmupFixture({ authIndex = 'exact-claude', provider = 'claude', name = `${provider}.json` } = {}) {
  let revision = 'wire-revision';
  const providers = {
    codex: { ...contract.default_policy },
    claude: { ...contract.credential.policy },
  };
  const credential = { ...structuredClone(contract.credential), auth_index: authIndex, provider, name };
  if (provider === 'codex') {
    credential.policy = { ...providers.codex };
    credential.models = ['gpt-codex-test'];
    credential.state.provider = provider;
  }
  let lastResult;
  return (url, method, body) => {
    let input;
    try { input = body ? JSON.parse(body) : {}; } catch { return { status: 400, json: { error: 'invalid request body' } }; }
    if (url.pathname.endsWith('/warmup/settings')) {
      if (method === 'PUT') {
        if (!input.confirmed || input.revision !== revision) return { status: 409, json: { code: 'resource_conflict', error: 'resource_conflict' } };
        providers[input.provider] = structuredClone(input.policy); revision += '-saved';
      }
      return { status: 200, json: { providers, models: { codex: ['gpt-codex-test'], claude: ['claude-haiku-test'] }, timezone: 'UTC', revision } };
    }
    if (url.pathname.endsWith('/run')) {
      const allowed = ['request_id', 'revision', 'confirmed'];
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))
        || ['request_id', 'revision'].some(key => input[key] != null && typeof input[key] !== 'string')
        || input.confirmed != null && typeof input.confirmed !== 'boolean') {
        return { status: 400, json: { error: 'invalid request body' } };
      }
      const requestId = input.request_id;
      const requestBytes = typeof requestId === 'string' ? new TextEncoder().encode(requestId).length : 0;
      if (input.confirmed !== true || typeof requestId !== 'string' || requestBytes < 8 || requestBytes > 128
        || requestId.trim() !== requestId || /[\r\n\u0000]/.test(requestId) || requestId.startsWith('auto/')) {
        return { status: 400, json: { code: 'invalid_parameters', error: 'invalid_parameters' } };
      }
      if (input.revision !== revision) return { status: 409, json: { code: 'resource_conflict', error: 'resource_conflict' } };
      lastResult = { ...contract.result, model: credential.policy.model, request_id: requestId };
      credential.state = { ...credential.state, protocol_verified: true, verified_model: credential.policy.model, last_result: lastResult };
      credential.reason = 'already_active';
      return { status: 200, json: lastResult };
    }
    if (method === 'PUT') {
      credential.inherit = input.inherit; credential.policy = input.inherit ? providers[provider] : input.policy;
      revision += '-saved';
    }
    return { status: 200, json: { ...credential, revision, state: credential.state } };
  };
}
