import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDocument, classifyPath } from './check-docs.mjs';

const checker = fileURLToPath(new URL('./check-docs.mjs', import.meta.url));

function fixture(t, document, files = []) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-docs-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectRoot, 'checked.md'), document);
  for (const file of files) {
    const absolute = path.join(projectRoot, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, '');
  }
  return projectRoot;
}

const kinds = (findings) => findings.map((finding) => finding.kind);

test('classifyPath refuses anything that is not a checkable repo path', () => {
  assert.equal(classifyPath('*'), null);
  assert.equal(classifyPath('pnpm install --frozen-lockfile'), null);
  assert.equal(classifyPath('https://models.dev/api.json'), null);
  assert.equal(classifyPath('localStorage'), null);
  // A host and port is not a line reference.
  assert.deepEqual(classifyPath('cpa:8317'), { path: 'cpa', lineRef: false });
  assert.deepEqual(classifyPath('internal/api/handler.go'), { path: 'internal/api/handler.go', lineRef: false });
  assert.deepEqual(classifyPath('internal/api/handler.go:53-128'), { path: 'internal/api/handler.go', lineRef: true });
  assert.deepEqual(classifyPath('internal/usage/ingest.Runner'), { path: 'internal/usage/ingest', lineRef: false });
});

test('accepts a document whose references all resolve', (t) => {
  const projectRoot = fixture(
    t,
    'See `internal/api/handler.go` and `docs/adr/0001-go-react-sqlite-modular-monolith.md`.',
    ['internal/api/handler.go', 'docs/adr/0001-go-react-sqlite-modular-monolith.md'],
  );
  assert.deepEqual(checkDocument({ file: 'checked.md' }, { projectRoot }), []);
});

test('reports a reference to a file that no longer exists', (t) => {
  const projectRoot = fixture(t, 'See `internal/api/handler.go` and `web/src/pages/GonePage.tsx`.', [
    'internal/api/handler.go',
  ]);
  const findings = checkDocument({ file: 'checked.md' }, { projectRoot });
  assert.deepEqual(kinds(findings), ['missing-path']);
  assert.match(findings[0].detail, /GonePage\.tsx/);
});

test('reports absolute line references outside archival documents', (t) => {
  const projectRoot = fixture(t, 'See `internal/api/handler.go:53-128`.', ['internal/api/handler.go']);
  assert.deepEqual(kinds(checkDocument({ file: 'checked.md' }, { projectRoot })), ['line-reference']);
  assert.deepEqual(checkDocument({ file: 'checked.md', archival: true }, { projectRoot }), []);
});

test('allows gitignored runtime paths but keeps the reason on file', (t) => {
  const projectRoot = fixture(t, 'The binary lives at `cpa/cli-proxy-api`.');
  assert.deepEqual(checkDocument({ file: 'checked.md' }, { projectRoot }), []);
});

test('reports references to artifacts that were deliberately retired', (t) => {
  const projectRoot = fixture(t, 'Configure `docs/DESIGN.md`.');
  const findings = checkDocument({ file: 'checked.md' }, { projectRoot });
  assert.ok(findings.some((finding) => finding.kind === 'retired-reference'));
  assert.ok(findings.every((finding) => !finding.detail.includes('undefined')));
});

test('reports a document that is listed for maintenance but missing', () => {
  const findings = checkDocument({ file: 'not-here.md' });
  assert.deepEqual(kinds(findings), ['missing-document']);
});

test('command exits non-zero when a reference is stale', (t) => {
  const projectRoot = fixture(t, 'See `internal/api/gone.go`.');
  const result = spawnSync(process.execPath, [checker, '--root', projectRoot, '--file', 'checked.md'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MISSING-PATH/);
});
