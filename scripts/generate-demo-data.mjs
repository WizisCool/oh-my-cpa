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
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_TEST = 'TestExportDemoDataset';
const GENERATE_TIMEOUT_MS = 300_000;

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

function goPlatformKey() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return `${os}-${arch}`;
}

async function resolveGoBinary(root = DEFAULT_ROOT) {
  try {
    await run('go', ['version'], { cwd: root });
    return 'go';
  } catch {
    // Fall through to bootstrapping the pinned Go SDK (used in Node-only Workers Builds).
  }

  const sdkDir = join(root, 'tmp', 'go-sdk');
  const binName = process.platform === 'win32' ? 'go.exe' : 'go';
  const cachedGo = join(sdkDir, 'go', 'bin', binName);
  if (existsSync(cachedGo)) return cachedGo;

  const versions = JSON.parse(await readFile(join(root, 'scripts', 'tools-versions.json'), 'utf8'));
  const key = goPlatformKey();
  const archive = versions?.go?.archives?.[key];
  if (!archive?.url || !archive?.sha256) {
    throw new Error(`go is not on PATH and tools-versions.json has no Go archive for ${key}`);
  }

  console.log(`go not found on PATH; downloading Go ${versions.go.version} (${key}) for demo export...`);
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
  return cachedGo;
}

export async function generateDemoDataset(root = DEFAULT_ROOT) {
  const dataDir = dirname(demoDatasetPath(root));
  await mkdir(dataDir, { recursive: true });
  const goBin = await resolveGoBinary(root);
  await run(goBin, ['test', './internal/api', '-run', `^${EXPORT_TEST}$`, '-count=1'], {
    cwd: root,
    timeout: GENERATE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      TZ: 'UTC',
      OMCPA_ENV_FILE: '/dev/null',
      OMCPA_DATA_DIR: dataDir,
      OMCPA_DEMO_EXPORT_DIR: dataDir,
    },
  });
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
