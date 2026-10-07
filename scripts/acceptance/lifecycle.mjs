import { once } from 'node:events';

const BROWSER_SERVERS = new WeakMap();

// BrowserServer exposes the owned child process; ordinary Browser does not.
export async function launchBrowser(browserType, options = {}) {
  const server = await browserType.launchServer({ ...options, host: '127.0.0.1', timeout: 20_000 });
  try {
    const browser = await browserType.connect(server.wsEndpoint(), { timeout: 20_000 });
    BROWSER_SERVERS.set(browser, server);
    return browser;
  } catch (error) {
    try { await withinBudget(server.close(), 2000, 'browser startup cleanup'); }
    catch { await stopProcess(server.process()); }
    throw error;
  }
}

// Bounds guard hangs; they are never success delays or assertion retries.
export async function withinBudget(task, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function stopProcess(child, milliseconds = 2000, { isGroup = false } = {}) {
  if (!child) return;
  const hasExited = child.exitCode !== null || child.signalCode !== null;
  const ownsGroup = isGroup && process.platform !== 'win32' && child.pid;
  if (hasExited && !ownsGroup) return;
  const closed = hasExited ? Promise.resolve() : once(child, 'close');
  const terminate = signal => {
    if (ownsGroup) {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    } else child.kill(signal);
  };
  terminate('SIGTERM');
  try { await withinBudget(closed, milliseconds, 'process shutdown'); }
  catch {
    terminate('SIGKILL');
    await withinBudget(closed, milliseconds, 'forced process shutdown');
  } finally {
    // A detached parent's close does not prove its descendants exited. Its group
    // remains ours even after that parent exits, so no inherited worker may outlive it.
    if (ownsGroup) terminate('SIGKILL');
  }
}

export async function closeBrowser(browser) {
  if (!browser) return;
  const server = BROWSER_SERVERS.get(browser);
  try {
    await withinBudget(server ? server.close() : browser.close(), 2000, 'browser shutdown');
  } catch (error) {
    if (!server) throw error;
    await stopProcess(server.process());
  } finally {
    BROWSER_SERVERS.delete(browser);
  }
}

export async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await withinBudget(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000, 'fixture server shutdown');
}

// Watchdog, signal and normal-finally callers share one teardown. Stop is visible
// immediately so a closed context cannot advance the loop into another scenario.
export function createShutdownController(cleanup) {
  let isStopping = false;
  let shutdownTask;
  return {
    get isStopping() { return isStopping; },
    shutdown() {
      if (!shutdownTask) {
        isStopping = true;
        shutdownTask = Promise.resolve().then(cleanup);
      }
      return shutdownTask;
    },
  };
}

export async function withOwnedCleanup(task, cleanup) {
  try { return await task(); }
  finally { await cleanup(); }
}
