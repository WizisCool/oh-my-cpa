import type { MessageKey } from '../../i18n/catalog';
import type { StatusTone } from '../common/StatusLabel';
import { formatPluginVersion, type BuiltinPlugin, type BuiltinPluginsResponse, type BuiltinPluginStatus } from '../../types/plugin';

/**
 * The tone of a built-in plugin's state. Only a confirmed running copy is a success; a
 * state the gateway has not confirmed is a warning; a plugin the catalog or another
 * source keeps from running is a fault.
 */
export const BUILTIN_STATUS_TONES: Record<BuiltinPluginStatus, StatusTone> = {
  running: 'success',
  pending: 'warn',
  indeterminate: 'warn',
  restart_required: 'warn',
  source_conflict: 'danger',
  blocked: 'danger',
  not_installed: 'neutral',
  disabled: 'neutral',
};

const BUILTIN_REASONS: Record<string, MessageKey> = {
  automation_disabled: 'plugin.builtin_reason_automation_disabled',
  catalog_unavailable: 'plugin.builtin_reason_catalog_unavailable',
  installed_from_another_source: 'plugin.builtin_reason_installed_from_another_source',
  unowned_plugin_exists: 'plugin.builtin_reason_unowned_plugin_exists',
  runtime_not_confirmed: 'plugin.builtin_reason_runtime_not_confirmed',
  cpa_unavailable: 'plugin.builtin_reason_cpa_unavailable',
};

/**
 * The sentence for a status reason, or `undefined` for a code this console does not know.
 * An unknown code is shown as the code itself - plain text, never upstream detail - so a
 * newer server's reason is still visible rather than dropped.
 */
export function builtinReasonKey(reason: string): MessageKey | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_REASONS, reason) ? BUILTIN_REASONS[reason] : undefined;
}

/**
 * How a failed policy write is reported. `conflict` means another write moved the policy
 * first: the state is re-read and the operator decides again, nothing is retried.
 * `saved-unconfirmed` is the server saying the policy was stored but the gateway did not
 * confirm acting on it - only that explicit code may claim the save happened. `refused`
 * is a request the server answered with a client error, so nothing was stored. Anything
 * else - no answer at all, or a server fault without a code - is `unknown`: the write may
 * or may not have landed, so the state is re-read instead of claiming either.
 *
 * `status` is the HTTP status, or 0 when no response arrived.
 */
export type BuiltinWriteFailure = 'conflict' | 'saved-unconfirmed' | 'refused' | 'unknown';

export function builtinWriteFailure(code: string, status: number): BuiltinWriteFailure {
  if (code === 'policy_revision_conflict') return 'conflict';
  if (code === 'builtin_policy_apply_incomplete') return 'saved-unconfirmed';
  return status >= 400 && status < 500 ? 'refused' : 'unknown';
}

/**
 * A built-in plugin's releases, reduced to what differs. Three versions travel with every
 * row - the catalog's, the installed file's and the running copy's - and they agree almost
 * always; the row names the installed one and adds another only where it says something:
 * a newer stable release, a catalog release not installed yet, or a running copy that
 * is not the file on disk.
 */
export interface BuiltinVersionFacts {
  current?: string;
  update?: string;
  available?: string;
  running?: string;
}

export function builtinVersionFacts(plugin: Pick<BuiltinPlugin, 'version' | 'installed_version' | 'runtime_version'>): BuiltinVersionFacts {
  const target = formatPluginVersion(plugin.version);
  const installed = formatPluginVersion(plugin.installed_version);
  const runtime = formatPluginVersion(plugin.runtime_version);
  if (!installed) return { available: target || undefined, running: runtime || undefined };
  return {
    current: installed,
    update: target && target !== installed ? target : undefined,
    running: runtime && runtime !== installed ? runtime : undefined,
  };
}

/** Whether the list is still settling, so it is read again until the gateway reports an outcome. */
export function hasPendingBuiltin(plugins: readonly BuiltinPlugin[]): boolean {
  return plugins.some((plugin) => plugin.status === 'pending');
}

/**
 * Waiting for the automation to act on a request.
 *
 * A check, switching the feature on, or switching a plugin on is accepted at once and run by
 * the worker afterwards; the answer to the request is the state before the run. The worker
 * stamps `last_reconcile_at` when a run completes, so the console reads again until the
 * stamp moves and nothing is in progress, and then reports what the run did. A run that
 * fails leaves the stamp where it was, so after the timeout the console says that it does
 * not know the outcome - never that the run succeeded.
 */
export const BUILTIN_OUTCOME_TIMEOUT_MS = 45_000;
export const BUILTIN_OUTCOME_INTERVAL_MS = 1_500;

interface BuiltinClock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const BROWSER_CLOCK: BuiltinClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => { window.setTimeout(resolve, milliseconds); }),
};

export interface BuiltinOutcomeWait {
  /** The worker finished a run after the request. */
  isSettled: boolean;
  response: BuiltinPluginsResponse;
}

export async function waitForBuiltinOutcome(
  previousRunAt: string,
  read: () => Promise<BuiltinPluginsResponse>,
  onRead: (response: BuiltinPluginsResponse) => void,
  signal: AbortSignal,
  clock: BuiltinClock = BROWSER_CLOCK,
  timeoutMs = BUILTIN_OUTCOME_TIMEOUT_MS,
  intervalMs = BUILTIN_OUTCOME_INTERVAL_MS,
): Promise<BuiltinOutcomeWait> {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    await clock.sleep(Math.min(intervalMs, Math.max(0, deadline - clock.now())));
    if (signal.aborted) throw signal.reason;
    const response = await read();
    onRead(response);
    if (response.last_reconcile_at !== previousRunAt && !hasPendingBuiltin(response.plugins)) return { isSettled: true, response };
    if (clock.now() >= deadline) return { isSettled: false, response };
  }
}

/** A plugin whose state needs the operator: it is not running and nobody asked it not to. */
export function needsAttention(plugin: BuiltinPlugin, isAutomationOn: boolean): boolean {
  if (plugin.status === 'running' || plugin.status === 'disabled' || plugin.status === 'pending') return false;
  if (plugin.status === 'not_installed') return isAutomationOn && plugin.policy.enabled;
  return true;
}

export type BuiltinChange = { id: string; name: string; kind: 'installed' | 'updated' | 'removed'; version: string };

/** What a run changed on disk, plugin by plugin, from the list before it and after it. */
export function builtinChanges(before: readonly BuiltinPlugin[], after: readonly BuiltinPlugin[]): BuiltinChange[] {
  const previous = new Map(before.map((plugin) => [plugin.id, plugin]));
  const changes: BuiltinChange[] = [];
  for (const plugin of after) {
    const was = previous.get(plugin.id)?.installed_version ?? '';
    const now = plugin.installed_version;
    if (was === now) continue;
    const name = plugin.name || plugin.id;
    if (!now) changes.push({ id: plugin.id, name, kind: 'removed', version: formatPluginVersion(was) });
    else changes.push({ id: plugin.id, name, kind: was ? 'updated' : 'installed', version: formatPluginVersion(now) });
  }
  return changes;
}
