import type { PluginsResponse } from '../../types/plugin';

/**
 * Waiting for the gateway to act on a plugin switch.
 *
 * CPA accepts the write at once and loads or unloads the plugin afterwards, so the list
 * read straight after a switch can still show the old state. The console reads again
 * until the running state agrees, and says when it gave up, rather than showing a
 * plugin as stopped that is about to run.
 */

export const PLUGIN_RUNTIME_TIMEOUT_MS = 15_000;
export const PLUGIN_RUNTIME_INTERVAL_MS = 500;

export type PluginRuntimeStatus = 'ready' | 'system-disabled' | 'timeout';

export interface PluginRuntimeWait {
  status: PluginRuntimeStatus;
  response: PluginsResponse;
}

interface PluginRuntimeClock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const BROWSER_CLOCK: PluginRuntimeClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => { window.setTimeout(resolve, milliseconds); }),
};

/** Whether the list shows the plugin in the state the switch asked for. */
export function pluginRuntimeStatus(response: PluginsResponse, pluginId: string, isEnabled: boolean): PluginRuntimeStatus | 'pending' {
  const plugin = response.plugins.find((item) => item.id === pluginId);
  // The stored switch has to agree as well as the runtime: with the plugin system off a
  // plugin is stopped whichever way its switch points, so a list read before the write
  // landed would otherwise confirm a change that is not there yet.
  if (!isEnabled) return !plugin || (!plugin.enabled && !plugin.effective_enabled) ? 'ready' : 'pending';
  if (!plugin?.enabled) return 'pending';
  // With the plugin system off nothing loads, however long the console waits.
  if (!response.plugins_enabled) return 'system-disabled';
  return plugin.registered && plugin.effective_enabled ? 'ready' : 'pending';
}

export async function waitForPluginRuntime(
  pluginId: string,
  isEnabled: boolean,
  readPlugins: () => Promise<PluginsResponse>,
  clock: PluginRuntimeClock = BROWSER_CLOCK,
  timeoutMs = PLUGIN_RUNTIME_TIMEOUT_MS,
  intervalMs = PLUGIN_RUNTIME_INTERVAL_MS,
): Promise<PluginRuntimeWait> {
  const deadline = clock.now() + timeoutMs;
  let response = await readPlugins();
  for (;;) {
    const status = pluginRuntimeStatus(response, pluginId, isEnabled);
    if (status !== 'pending') return { status, response };
    const remaining = deadline - clock.now();
    if (remaining <= 0) return { status: 'timeout', response };
    await clock.sleep(Math.min(intervalMs, remaining));
    response = await readPlugins();
  }
}
