#!/usr/bin/env node
/**
 * Generates the dataset the public demonstration is served from into the
 * gitignored `deploy/cloudflare/data/responses.json` path.
 *
 * The dataset is exported from the real Go handlers (`TestExportDemoDataset` in
 * `internal/api/demo_export_test.go`) so CI and Cloudflare Workers Builds produce
 * it directly from the checked-out Go code without committing a multi-megabyte
 * JSON artifact to Git.
 *
 *   pnpm demo:generate               regenerate responses.json
 *   node scripts/generate-demo-data.mjs --if-missing
 */
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_TEST = 'TestExportDemoDataset';
// Cold Go module downloads + compiling internal/api on 2-vCPU CI containers (e.g.
// Cloudflare Workers Builds without Go build cache) can exceed 5 minutes; give 15m.
const GENERATE_TIMEOUT_MS = 900_000;
const STDERR_TAIL_BYTES = 16 * 1024;

export function demoDatasetPath(root = DEFAULT_ROOT) {
  return join(root, 'deploy', 'cloudflare', 'data', 'responses.json');
}

function demoStampPath(root = DEFAULT_ROOT) {
  return join(root, 'deploy', 'cloudflare', 'data', 'responses.stamp');
}

async function collectInputFiles(dir, out) {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '.git') continue;
      await collectInputFiles(full, out);
    } else if (entry.isFile() && /\.(go|json|yaml|yml|sql)$/.test(entry.name)) {
      out.push(full);
    }
  }
}

async function computeExportFingerprint(root = DEFAULT_ROOT) {
  const hash = createHash('sha256');
  const files = [];
  for (const fixed of ['go.mod', 'go.sum', 'scripts/generate-demo-data.mjs']) {
    const full = join(root, fixed);
    if (existsSync(full)) files.push(full);
  }
  await collectInputFiles(join(root, 'internal'), files);
  await collectInputFiles(join(root, 'migrations'), files);
  files.sort();
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function parseGoVersion(text) {
  const match = /go([0-9]+)\.([0-9]+)(?:\.([0-9]+))?/.exec(String(text));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function compareGoVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export async function readRequiredGoVersion(root = DEFAULT_ROOT) {
  const goModPath = join(root, 'go.mod');
  if (!existsSync(goModPath)) return null;
  const content = await readFile(goModPath, 'utf8');
  const match = /^go\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/m.exec(content);
  if (!match) return null;
  return parseGoVersion(`go${match[1]}`);
}

function goPlatformKey() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return `${os}-${arch}`;
}

async function probeGoVersion(bin, root, env = process.env) {
  try {
    const { stdout } = await run(bin, ['version'], { cwd: root, env });
    return parseGoVersion(stdout);
  } catch {
    return null;
  }
}

export async function resolveGoBinary(root = DEFAULT_ROOT, { env = process.env } = {}) {
  const required = await readRequiredGoVersion(root);
  const pathVersion = await probeGoVersion('go', root, env);
  if (pathVersion && (!required || compareGoVersions(pathVersion, required) >= 0)) {
    return { bin: 'go', env: {} };
  }

  const sdkDir = join(root, 'tmp', 'go-sdk');
  const sdkRoot = join(sdkDir, 'go');
  const binName = process.platform === 'win32' ? 'go.exe' : 'go';
  const cachedGo = join(sdkRoot, 'bin', binName);
  const versions = JSON.parse(await readFile(join(root, 'scripts', 'tools-versions.json'), 'utf8'));
  const pinnedVersion = parseGoVersion(`go${versions?.go?.version ?? ''}`);

  const sdkEnv = { GOROOT: sdkRoot, GOTOOLCHAIN: 'local' };
  if (existsSync(cachedGo)) {
    const cachedVersion = await probeGoVersion(cachedGo, root, { ...env, ...sdkEnv });
    const matchesPinned = pinnedVersion && cachedVersion && compareGoVersions(cachedVersion, pinnedVersion) === 0;
    const satisfiesMod = cachedVersion && (!required || compareGoVersions(cachedVersion, required) >= 0);
    if (matchesPinned || (!pinnedVersion && satisfiesMod)) {
      return { bin: cachedGo, env: sdkEnv };
    }
  }

  const key = goPlatformKey();
  const archive = versions?.go?.archives?.[key];
  if (!archive?.url || !archive?.sha256) {
    throw new Error(`go >= ${required?.join('.') ?? 'required'} is not on PATH and tools-versions.json has no Go archive for ${key}`);
  }

  const reason = pathVersion
    ? `go ${pathVersion.join('.')} on PATH is older than go.mod (${required?.join('.')})`
    : 'go not found on PATH';
  console.log(`${reason}; downloading Go ${versions.go.version} (${key}) for demo export...`);
  await rm(sdkRoot, { recursive: true, force: true });
  await mkdir(sdkDir, { recursive: true });
  const response = await fetch(archive.url);
  if (!response.ok) {
    throw new Error(`download Go toolchain from ${archive.url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== archive.sha256) {
    throw new Error(`Go archive checksum mismatch: got ${digest}, want ${archive.sha256}`);
  }

  const archiveFile = join(sdkDir, archive.url.endsWith('.zip') ? 'go.zip' : 'go.tar.gz');
  await writeFile(archiveFile, bytes);
  if (archiveFile.endsWith('.zip')) {
    await run('unzip', ['-q', archiveFile, '-d', sdkDir], { cwd: root });
  } else {
    await run('tar', ['-xzf', archiveFile, '-C', sdkDir], { cwd: root });
  }
  await rm(archiveFile, { force: true });
  return { bin: cachedGo, env: sdkEnv };
}

function runStreaming(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    let timedOut = false;
    let killTimer;

    const appendTail = (text) => {
      tail += text;
      if (tail.length > STDERR_TAIL_BYTES) {
        tail = tail.slice(-STDERR_TAIL_BYTES);
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
      appendTail(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
      appendTail(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5_000);
      killTimer.unref?.();
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      rejectPromise(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        rejectPromise(new Error(`${command} ${args.join(' ')} timed out after ${Math.round(timeoutMs / 1000)}s\n${tail}`.trim()));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`})\n${tail}`.trim()));
        return;
      }
      resolvePromise();
    });
  });
}

export async function generateDemoDataset(root = DEFAULT_ROOT) {
  const dataDir = dirname(demoDatasetPath(root));
  await mkdir(dataDir, { recursive: true });
  const { bin: goBin, env: goEnv } = await resolveGoBinary(root);
  await runStreaming(
    goBin,
    ['test', '-vet=off', '-ldflags=-s -w', './internal/api', '-run', `^${EXPORT_TEST}$`, '-count=1'],
    {
      cwd: root,
      timeoutMs: GENERATE_TIMEOUT_MS,
      env: {
        ...process.env,
        ...goEnv,
        CGO_ENABLED: process.env.CGO_ENABLED ?? '0',
        TZ: 'UTC',
        OMCPA_ENV_FILE: '/dev/null',
        OMCPA_DATA_DIR: dataDir,
        OMCPA_DEMO_EXPORT_DIR: dataDir,
      },
    },
  );
  const fingerprint = await computeExportFingerprint(root);
  await writeFile(demoStampPath(root), `${fingerprint}\n`, 'utf8');
  return demoDatasetPath(root);
}

export async function ensureDemoDataset(root = DEFAULT_ROOT, { force = false } = {}) {
  const target = demoDatasetPath(root);
  const stamp = demoStampPath(root);
  if (!force && existsSync(target) && existsSync(stamp)) {
    const [info, recorded] = await Promise.all([stat(target), readFile(stamp, 'utf8')]);
    if (info.size > 0 && recorded.trim() === (await computeExportFingerprint(root))) {
      return target;
    }
  }
  return generateDemoDataset(root);
}

async function main() {
  const ifMissing = process.argv.includes('--if-missing');
  const existed = existsSync(demoDatasetPath(DEFAULT_ROOT));
  const target = await ensureDemoDataset(DEFAULT_ROOT, { force: !ifMissing });
  if (ifMissing && existed) {
    return;
  }
  const raw = await readFile(target, 'utf8');
  console.log(`wrote ${target} (${(raw.length / 1024).toFixed(1)} KB)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`demo-generate: ${error.message}`);
    process.exitCode = 1;
  });
}
