// One-command development loop for Oh My CPA:
//   pnpm dev       -> Air (Go API) + Vite (frontend HMR)
//   pnpm dev:api   -> Air only
//   pnpm dev:web   -> Vite only (declared in package.json)
//
// The browser entry is Vite at http://127.0.0.1:5173/omc/ (or http://<tailscale-ip>:5173/omc/).
// Vite sends /omc/api to Go at 127.0.0.1:8080. CPA remains an external dependency and can
// be started separately with `pnpm cpa:start` when real integration is needed.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiOnly = process.argv.includes('--api-only');
const isWindows = process.platform === 'win32';
const children = new Map();
let stopping = false;
let shutdownPromise;

function executableOnPath(command) {
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = isWindows
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  const hasExtension = path.extname(command) !== '';

  for (const entry of pathEntries) {
    const directory = entry.replace(/^"|"$/g, '');
    for (const extension of hasExtension ? [''] : extensions) {
      const candidate = path.join(directory, command + extension.toLowerCase());
      if (fs.existsSync(candidate)) return candidate;
      if (isWindows) {
        const upperCandidate = path.join(directory, command + extension.toUpperCase());
        if (fs.existsSync(upperCandidate)) return upperCandidate;
      }
    }
  }
  return '';
}

function goEnv(name) {
  try {
    return execFileSync('go', ['env', name], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function resolveAir() {
  const binaryName = isWindows ? 'air.exe' : 'air';
  const configured = (process.env.AIR_BIN || '').trim();
  if (configured) {
    const explicit = path.isAbsolute(configured) ? configured : path.resolve(root, configured);
    const resolved = fs.existsSync(explicit) ? explicit : executableOnPath(configured);
    if (resolved) return resolved;
    throw new Error(`AIR_BIN does not point to an executable: ${configured}`);
  }

  const fromPath = executableOnPath('air');
  if (fromPath) return fromPath;

  const candidates = [];
  const goBin = goEnv('GOBIN');
  if (goBin) candidates.push(path.join(goBin, binaryName));
  for (const goPath of goEnv('GOPATH').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(goPath, 'bin', binaryName));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;

  throw new Error(
    'Air was not found in AIR_BIN, PATH, GOBIN, or GOPATH/bin. Install it with:\n' +
      '  go install github.com/air-verse/air@latest',
  );
}

function resolveVite() {
  const vite = path.join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) {
    throw new Error('Vite is not installed. Run `pnpm install --frozen-lockfile` first.');
  }
  return vite;
}

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    detached: !isWindows,
    ...options,
  });
  children.set(name, child);

  child.once('error', (error) => {
    if (!stopping) void shutdown(1, `${name} failed to start: ${error.message}`);
  });
  child.once('close', (code, signal) => {
    children.delete(name);
    if (!stopping) {
      const result = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      void shutdown(code === 0 ? 0 : 1, `${name} exited (${result})`);
    }
  });
  return child;
}

function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('close', finish);

    try {
      if (isWindows) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          shell: false,
        });
        killer.once('error', () => {
          try { child.kill(); } catch { /* already stopped */ }
        });
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      try { child.kill(); } catch { /* already stopped */ }
    }

    const timeout = setTimeout(() => {
      try {
        if (!isWindows && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already stopped
      }
      finish();
    }, 5000);
    timeout.unref();
  });
}

function shutdown(exitCode, reason) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  if (reason) console.error(`\n[dev] ${reason}; stopping the development loop.`);
  shutdownPromise = Promise.all([...children.values()].map(stopChild)).then(() => {
    process.exitCode = exitCode;
  });
  return shutdownPromise;
}

process.once('SIGINT', () => void shutdown(0, 'received SIGINT'));
process.once('SIGTERM', () => void shutdown(0, 'received SIGTERM'));

try {
  const air = resolveAir();
  if (apiOnly) {
    console.log('[dev] mode: Go API only (:8080)');
  } else {
    console.log('[dev] topology: browser -> Vite :5173 (0.0.0.0) -> Go API :8080 (127.0.0.1) -> external CPA');
    console.log('[dev] open: http://127.0.0.1:5173/omc/ (or http://<tailscale-ip>:5173/omc/)');
  }
  console.log('[dev] CPA is external; start it separately with `pnpm cpa:start` when needed.\n');

  start('Go API', air, []);
  if (!apiOnly) start('Vite', process.execPath, [resolveVite()], { cwd: path.join(root, 'web') });
} catch (error) {
  await shutdown(1, error instanceof Error ? error.message : String(error));
}
