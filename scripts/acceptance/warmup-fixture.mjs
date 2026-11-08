import contract from './contracts/warmup.json' with { type: 'json' };
export const WARMUP_CONTRACT = contract;

const ALLOWED_TASK_KEYS = new Set(['name', 'enabled', 'provider', 'auth_index', 'account', 'model', 'trigger']);
const ALLOWED_TRIGGER_KEYS = new Set(['kind', 'window', 'time', 'time_zone', 'hours', 'anchor']);

function validateTaskPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { status: 400, json: { error: 'invalid request body' } };
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_TASK_KEYS.has(key)) {
      return { status: 400, json: { error: 'invalid request body' } };
    }
  }
  const trigger = input.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    return { status: 400, json: { code: 'invalid_parameters', error: 'invalid_parameters' } };
  }
  for (const key of Object.keys(trigger)) {
    if (!ALLOWED_TRIGGER_KEYS.has(key)) {
      return { status: 400, json: { error: 'invalid request body' } };
    }
  }
  if (!input.provider || typeof input.provider !== 'string' || !input.provider.trim()) {
    return { status: 400, json: { code: 'invalid_parameters', error: 'invalid_parameters' } };
  }
  if ((!input.auth_index || !String(input.auth_index).trim()) && (!input.account || !String(input.account).trim())) {
    return { status: 400, json: { code: 'invalid_parameters', error: 'invalid_parameters' } };
  }
  if (trigger.kind === 'window') {
    if (!trigger.window || typeof trigger.window !== 'string' || !trigger.window.trim()) {
      return { status: 400, json: { code: 'invalid_parameters', error: 'invalid_parameters' } };
    }
  } else if (trigger.kind === 'daily') {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trigger.time ?? '')) {
      return { status: 400, json: { code: 'invalid_parameters', error: 'invalid_parameters' } };
    }
  } else if (trigger.kind === 'every') {
    if (typeof trigger.hours !== 'number' || !Number.isInteger(trigger.hours) || trigger.hours < 1 || trigger.hours > 168 || !trigger.anchor) {
      return { status: 400, json: { code: 'invalid_parameters', error: 'invalid_parameters' } };
    }
  } else {
    return { status: 400, json: { code: 'invalid_parameters', error: 'invalid_parameters' } };
  }
  return null;
}

/** A bounded projection fixture; Go certifies the wire shape and refusal cases. */
export function createWarmupFixture({ initialTasks } = {}) {
  const state = structuredClone(contract.state);
  if (Array.isArray(initialTasks)) {
    state.tasks = structuredClone(initialTasks);
    state.next = Object.fromEntries(state.tasks.map((t) => [t.id, null]));
  }
  let seq = 1;

  return (url, method, body) => {
    let input = {};
    if (body) {
      try {
        input = JSON.parse(body);
      } catch {
        return { status: 400, json: { error: 'invalid request body' } };
      }
    }

    if (url.pathname.endsWith('/warmup/settings') && method === 'GET') {
      return { status: 200, json: structuredClone(state) };
    }

    if (url.pathname.endsWith('/warmup/tasks') && method === 'POST') {
      const err = validateTaskPayload(input);
      if (err) return err;
      const id = `t_fixture_${seq++}`;
      const account = input.account || input.auth_index || 'claude.json';
      const task = {
        id,
        name: input.name?.trim() || `${account} · 窗口重置后 (5h)`,
        enabled: Boolean(input.enabled),
        provider: input.provider,
        auth_index: input.auth_index || 'exact-claude',
        account,
        model: input.model ?? '',
        trigger: structuredClone(input.trigger),
        created_at: '2026-10-13T06:00:00Z',
        updated_at: '2026-10-13T06:00:00Z',
      };
      state.tasks.push(task);
      state.next[id] = task.enabled && task.trigger.kind === 'daily' ? `2026-10-13T${task.trigger.time}:00Z` : null;
      return { status: 201, json: structuredClone(state) };
    }

    const runMatch = url.pathname.match(/\/warmup\/tasks\/([^/]+)\/run$/);
    if (runMatch && method === 'POST') {
      const taskId = decodeURIComponent(runMatch[1]);
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return { status: 404, json: { code: 'resource_not_found', error: 'resource_not_found' } };
      const run = {
        ...structuredClone(contract.run),
        id: taskId === 't_wire_test' ? 'r_wire_test' : `r_fixture_${seq++}`,
        task_id: task.id,
        task_name: task.name,
        provider: task.provider,
        auth_index: task.auth_index,
        account: task.account,
        model: task.model || 'claude-haiku-4-5',
      };
      state.runs = [run, ...state.runs];
      return { status: 200, json: { run: structuredClone(run), state: structuredClone(state) } };
    }

    const itemMatch = url.pathname.match(/\/warmup\/tasks\/([^/]+)$/);
    if (itemMatch) {
      const taskId = decodeURIComponent(itemMatch[1]);
      const idx = state.tasks.findIndex((t) => t.id === taskId);
      if (idx < 0) return { status: 404, json: { code: 'resource_not_found', error: 'resource_not_found' } };
      if (method === 'PUT') {
        const err = validateTaskPayload(input);
        if (err) return err;
        const existing = state.tasks[idx];
        const updated = {
          ...existing,
          name: input.name?.trim() || existing.name,
          enabled: Boolean(input.enabled),
          provider: input.provider,
          auth_index: input.auth_index || existing.auth_index,
          account: input.account || existing.account,
          model: input.model ?? '',
          trigger: structuredClone(input.trigger),
          updated_at: '2026-10-13T06:00:00Z',
        };
        state.tasks[idx] = updated;
        state.next[taskId] = updated.enabled && updated.trigger.kind === 'daily' ? `2026-10-13T${updated.trigger.time}:00Z` : null;
        return { status: 200, json: structuredClone(state) };
      }
      if (method === 'DELETE') {
        state.tasks.splice(idx, 1);
        delete state.next[taskId];
        return { status: 200, json: structuredClone(state) };
      }
    }

    return { status: 404, json: { code: 'resource_not_found', error: 'resource_not_found' } };
  };
}
