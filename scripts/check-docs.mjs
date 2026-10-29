import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureTool } from './pinned-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = await ensureTool('lychee');
const result = spawnSync(executable, [
  '--offline', '--include-fragments', '--no-progress',
  '*.md', 'docs/**/*.md', 'web/src/i18n/*.md',
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
