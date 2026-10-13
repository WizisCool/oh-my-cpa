import contract from './contracts/warmup.json' with { type: 'json' };
export const WARMUP_CONTRACT = contract;

/** A bounded projection fixture; Go certifies the wire shape and refusal cases. */
export function createWarmupFixture({ authIndex = 'exact-claude', provider = 'claude' } = {}) {
  let revision = 'wire-revision';
  const providers = {
    codex: { ...contract.default_policy },
    claude: { ...contract.credential.policy },
  };
  const credential = { ...structuredClone(contract.credential), auth_index: authIndex, provider };
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
      const refusal = contract.cases.find(entry => JSON.stringify(entry.body) === JSON.stringify(input));
      if (refusal) return { status: refusal.status, json: refusal.response };
      lastResult = { ...contract.result, request_id: input.request_id };
      credential.state = { ...credential.state, protocol_verified: true, last_result: lastResult };
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
