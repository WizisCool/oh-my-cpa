import contract from './contracts/system-updater.json' with { type: 'json' };
export const SYSTEM_UPDATER_CONTRACT = contract;

const APPLY_PATH = '/management/system/updater/apply';
const STATUS_PATH = '/management/system/updater';

/**
 * The console's updater routes over one in-memory updater; Go certifies the wire shape and
 * the refusals. `advance` moves the admitted job, which the real sidecar does on its own.
 */
export function createSystemUpdaterFixture({ state = 'ready' } = {}) {
  let status = structuredClone(state === 'ready' ? contract.ready : { ...contract.not_installed, state });
  const respond = (url, method, body) => {
    if (url.pathname.endsWith(STATUS_PATH) && method === 'GET') return { status: 200, json: structuredClone(status) };
    if (!url.pathname.endsWith(APPLY_PATH) || method !== 'POST') return { status: 404, json: { error: 'not found' } };
    let input;
    try { input = JSON.parse(body); } catch { return { status: 400, json: { error: 'invalid request body' } }; }
    const refusal = contract.refusals.find((entry) => entry.body.product === input?.product);
    if (refusal) return { status: refusal.status, json: structuredClone(refusal.response) };
    if (input?.product !== contract.accepted.body.product) return { status: 400, json: { error: 'unknown release product' } };
    status = { ...status, job: structuredClone(contract.accepted.job) };
    return { status: contract.accepted.status, json: structuredClone(status) };
  };
  respond.advance = (stage, error = '') => {
    const isFinished = ['done', 'already_current', 'rolled_back', 'failed'].includes(stage);
    status = { ...status, job: { ...status.job, stage, error, finished: isFinished } };
  };
  return respond;
}
