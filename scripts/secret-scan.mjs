import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'tools-versions.json'), 'utf8'));
const version = manifest.gitleaks.version;

function platformKey() {
  const osName = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  const archName = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!osName || !archName) throw new Error(`unsupported gitleaks platform: ${process.platform}-${process.arch}`);
  return `${osName}-${archName}`;
}

function binaryPath() {
  const configured = process.env.GITLEAKS_BIN?.trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
  return path.join(root, '.tools', 'gitleaks', version, platformKey(), process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GitHub release assets are fetched on every run: .tools/ is gitignored, so CI
 * never has gitleaks pre-installed and each gate run pulls the pinned archive.
 * A single reset connection used to fail the entire job, so transport failures
 * are retried here. A checksum mismatch is deliberately NOT retried - that is a
 * supply-chain signal and belongs in the caller, which fails loudly on it.
 */
async function download(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      // A non-transient status means the pinned URL or the release itself is
      // wrong; retrying cannot change that.
      if (response.status < 500 && response.status !== 429) {
        throw Object.assign(
          new Error(`gitleaks download failed: ${response.status} ${response.statusText}`),
          { isNonRetryable: true },
        );
      }
      lastError = new Error(`gitleaks download failed: ${response.status} ${response.statusText}`);
    } catch (error) {
      if (error?.isNonRetryable) throw error;
      lastError = error;
    }
    if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
  }
  throw lastError;
}

async function ensureGitleaks() {
  const executable = binaryPath();
  if (fs.existsSync(executable)) {
    const actual = execFileSync(executable, ['version'], { encoding: 'utf8' }).trim();
    if (actual !== version) throw new Error(`gitleaks version mismatch: found ${actual}, expected ${version}`);
    return executable;
  }
  if (process.env.GITLEAKS_BIN) throw new Error(`GITLEAKS_BIN does not exist: ${executable}`);

  const archive = manifest.gitleaks.archives[platformKey()];
  if (!archive) throw new Error(`missing gitleaks archive metadata for ${platformKey()}`);
  const bytes = await download(archive.url);
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== archive.sha256) {
    throw new Error(`gitleaks archive checksum mismatch for ${platformKey()}`);
  }

  const installDirectory = path.dirname(executable);
  fs.mkdirSync(installDirectory, { recursive: true });
  const extension = archive.url.endsWith('.zip') ? '.zip' : '.tar.gz';
  const archivePath = path.join(installDirectory, `gitleaks${extension}`);
  fs.writeFileSync(archivePath, bytes);
  try {
    execFileSync('tar', ['-xf', archivePath, '-C', installDirectory], { stdio: 'inherit' });
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
  const actual = execFileSync(executable, ['version'], { encoding: 'utf8' }).trim();
  if (actual !== version) throw new Error(`installed gitleaks version mismatch: found ${actual}, expected ${version}`);
  return executable;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}

function commonArgs() {
  return ['--config', path.join(root, 'gitleaks.toml'), '--redact=100', '--no-banner', '--no-color'];
}

function copyTrackedWorktree() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-secret-scan-'));
  const listing = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  for (const relative of listing.split('\0').filter(Boolean)) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const destination = path.join(temporary, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return temporary;
}

const mode = process.argv[2];
if (!['--staged', '--worktree', '--history'].includes(mode)) {
  throw new Error('usage: node scripts/secret-scan.mjs --staged|--worktree|--history');
}

const executable = await ensureGitleaks();
if (mode === '--staged') {
  run(executable, ['git', '--staged', ...commonArgs(), '.']);
} else if (mode === '--history') {
  run(executable, ['git', ...commonArgs(), '.']);
} else {
  const temporary = copyTrackedWorktree();
  try {
    run(executable, ['dir', ...commonArgs(), temporary]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
