/**
 * Generates `docs/openapi/swagger.json` from Go handler annotations in `internal/api`
 * using the pinned `github.com/swaggo/swag/cmd/swag` Go tool (`go.mod`).
 *
 * Run `pnpm openapi:generate` after adding, changing, or removing any `/api` route or DTO.
 * Run `pnpm check:openapi` (used in CI) to verify `docs/openapi/swagger.json` is up to date
 * without mutating the working tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'docs', 'openapi', 'swagger.json');
const checkOnly = process.argv.includes('--check');

function runSwag(outputDir) {
  execFileSync(
    'go',
    [
      'tool',
      'swag',
      'init',
      '--generalInfo',
      'swagger.go',
      '--dir',
      'internal/api,internal/domain',
      '--parseInternal',
      '--parseDependencyLevel',
      '1',
      '--propertyStrategy',
      'snakecase',
      '--output',
      outputDir,
      '--outputTypes',
      'json',
      '--quiet',
    ],
    { cwd: root, stdio: 'inherit' },
  );
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-openapi-'));
try {
  runSwag(tempDir);
  const generatedPath = path.join(tempDir, 'swagger.json');
  const parsed = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
  const normalized = `${JSON.stringify(parsed, null, 2)}\n`;

  if (checkOnly) {
    const committed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (committed !== normalized) {
      console.error('docs/openapi/swagger.json is out of date: run `pnpm openapi:generate` and commit the result.');
      process.exitCode = 1;
    } else {
      console.log('OK    docs/openapi/swagger.json is up to date.');
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, normalized);
    console.log(`wrote ${path.relative(root, target)} (${normalized.length} bytes)`);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
