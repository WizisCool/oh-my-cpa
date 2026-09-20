/**
 * Verifies the base-path normalisation the deployment files rely on.
 *
 * `deploy/base-path.sh` restates what `internal/config.NormalizeBasePath` does, for
 * the two components that build a URL or a proxy matcher from the raw environment
 * value before the server sees it. The two implementations only stay in agreement
 * if something checks them, and a divergence is not cosmetic: `/omc/` produced a
 * Caddy matcher of `/omc//*` that sent every console request to the CPA upstream,
 * and the same value produced an unfetchable healthcheck URL.
 *
 * The suite runs the script exactly as the container does, so it exercises the
 * shipped artefact rather than a copy of its rules.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'deploy', 'base-path.sh');

const probe = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' });
const hasShell = probe.error === undefined && probe.status === 0;

function basePath(rawValue) {
  return spawnSync('sh', [script], {
    encoding: 'utf8',
    env: { ...process.env, OMCPA_BASE_PATH: rawValue },
  });
}

// The same table as the Go test for NormalizeBasePath, including the empty result
// that means the site root.
const ACCEPTED = [
  { name: 'unset value means the documented default', input: '', want: '/omc' },
  { name: 'plain name', input: 'omc', want: '/omc' },
  { name: 'absolute path', input: '/omc', want: '/omc' },
  { name: 'trailing slash', input: '/omc/', want: '/omc' },
  { name: 'nested path with trailing slash', input: '/tools/omc/', want: '/tools/omc' },
  { name: 'duplicate slashes', input: '/a//b/', want: '/a/b' },
  { name: 'single dot segment', input: '/omc/./x', want: '/omc/x' },
  { name: 'surrounding whitespace', input: '  /omc  ', want: '/omc' },
  { name: 'site root', input: '/', want: '' },
  { name: 'only slashes is the site root', input: '//', want: '' },
];

test('deploy/base-path.sh agrees with the server on every accepted value', { skip: hasShell ? false : 'requires a POSIX shell' }, () => {
  for (const { name, input, want } of ACCEPTED) {
    const result = basePath(input);
    assert.equal(result.status, 0, `${name}: exited ${result.status}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), want, name);
  }
});

test('deploy/base-path.sh refuses values the server refuses', { skip: hasShell ? false : 'requires a POSIX shell' }, () => {
  for (const input of ['/omc?x=1', '/omc#fragment', '/../omc']) {
    const result = basePath(input);
    assert.notEqual(result.status, 0, `${input} was accepted`);
    assert.match(result.stderr, /OMCPA_BASE_PATH/, `${input} failed without naming the variable`);
  }
});

// The script splits the value on "/" with word-splitting, and an unquoted
// expansion also globs. A base path containing "*" is therefore expanded against
// whatever the process happens to be sitting next to, while the server keeps the
// literal character - the proxy and the application would end up on different
// paths. "?" is refused before this point as URL syntax, so only the glob
// metacharacter is reachable.
test('deploy/base-path.sh does not glob a path segment', { skip: hasShell ? false : 'requires a POSIX shell' }, () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-base-path-'));
  try {
    // Matching names, so a globbing shell would substitute them.
    fs.writeFileSync(path.join(workdir, 'alpha'), '');
    fs.writeFileSync(path.join(workdir, 'beta'), '');
    const result = spawnSync('sh', [script], {
      encoding: 'utf8',
      cwd: workdir,
      env: { ...process.env, OMCPA_BASE_PATH: '/console/*' },
    });
    assert.equal(result.status, 0, `exited ${result.status}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), '/console/*', 'the glob metacharacter must survive');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});
