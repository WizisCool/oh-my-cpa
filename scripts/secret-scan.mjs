import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureTool } from './pinned-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const executable = await ensureTool('gitleaks', ['version']);
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
