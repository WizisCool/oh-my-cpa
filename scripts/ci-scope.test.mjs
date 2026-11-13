import assert from 'node:assert/strict';
import test from 'node:test';
import { decideRunScope, scopeOf } from './ci-scope.mjs';

test('docs-only and review config changes skip heavy Go, frontend, browser, and docker lanes', () => {
  assert.deepEqual(scopeOf(['README.md', 'docs/testing.md', '.coderabbit.yaml', 'lychee.toml']), {
    go: false,
    frontend: false,
    browser: false,
    docker: false,
  });
});

test('Go backend changes trigger go + browser, and API/migration changes also verify demo parity in frontend', () => {
  assert.deepEqual(scopeOf(['internal/quota/forecast.go']), {
    go: true,
    frontend: false,
    browser: true,
    docker: false,
  });
  assert.deepEqual(scopeOf(['internal/api/dashboard.go']), {
    go: true,
    frontend: true,
    browser: true,
    docker: false,
  });
  assert.deepEqual(scopeOf(['migrations/020_example.sql']), {
    go: true,
    frontend: true,
    browser: true,
    docker: false,
  });
});

test('frontend-only changes skip Go unit tests while keeping browser and frontend gates', () => {
  assert.deepEqual(scopeOf(['web/src/pages/Dashboard.tsx']), {
    go: false,
    frontend: true,
    browser: true,
    docker: false,
  });
  // Shared API contracts and web/public assets are also read by Go tests.
  assert.deepEqual(scopeOf(['scripts/acceptance/contracts/warmup.json']), {
    go: true,
    frontend: true,
    browser: true,
    docker: false,
  });
  assert.deepEqual(scopeOf(['web/index.html']), {
    go: true,
    frontend: true,
    browser: true,
    docker: false,
  });
  // Vite build plugins and browser-stage scripts must run the production build and browser checks.
  for (const script of [
    'scripts/compact-locales.mjs',
    'scripts/sync-lobe-icons.mjs',
    'scripts/api-target.mjs',
    'scripts/dev-base-redirect.mjs',
    'scripts/build-demo.mjs',
    'scripts/generate-demo-data.mjs',
    'scripts/bundle-reference.json',
  ]) {
    assert.deepEqual(scopeOf([script]), {
      go: false,
      frontend: true,
      browser: true,
      docker: false,
    }, script);
  }
});

test('container, lockfile, CI, and unrecognized changes trigger docker or full verification conservatively', () => {
  assert.deepEqual(scopeOf(['Dockerfile']), {
    go: false,
    frontend: false,
    browser: false,
    docker: true,
  });
  assert.deepEqual(scopeOf(['pnpm-lock.yaml']), {
    go: true,
    frontend: true,
    browser: true,
    docker: true,
  });
  assert.deepEqual(scopeOf(['.github/workflows/ci.yml']), {
    go: true,
    frontend: true,
    browser: true,
    docker: true,
  });
  assert.deepEqual(scopeOf(['unexpected/new-top-level.txt']), {
    go: true,
    frontend: true,
    browser: true,
    docker: true,
  });
});

test('decideRunScope handles main pushes, full-ci labels, and base-diff failures safely', () => {
  const diffReturning = (files) => () => `${files.join('\0')}\0`;

  // Ordinary main push runs full verification without paying docker cost unless container inputs changed.
  assert.deepEqual(
    decideRunScope({ EVENT: 'push', REF: 'refs/heads/main', BASE: 'abc123' }, diffReturning(['internal/quota/a.go'])),
    { go: true, frontend: true, browser: true, docker: false, full: true, fileCount: 1 },
  );
  assert.deepEqual(
    decideRunScope({ EVENT: 'push', REF: 'refs/heads/main', BASE: 'abc123' }, diffReturning(['Dockerfile'])),
    { go: true, frontend: true, browser: true, docker: true, full: true, fileCount: 1 },
  );

  // Full-ci label forces every lane including docker and full browser acceptance.
  assert.deepEqual(
    decideRunScope({ EVENT: 'pull_request', BASE: 'abc123', LABELS: '["full-ci"]' }, diffReturning(['README.md'])),
    { go: true, frontend: true, browser: true, docker: true, full: true, fileCount: null },
  );

  // Missing or zero base SHA, or failing git diff, fails closed to full verification.
  assert.deepEqual(
    decideRunScope({ EVENT: 'pull_request', BASE: '0000000000000000000000000000000000000000' }),
    { go: true, frontend: true, browser: true, docker: true, full: true, fileCount: null },
  );
  assert.deepEqual(
    decideRunScope({ EVENT: 'pull_request', BASE: 'abc123' }, () => { throw new Error('git diff failed'); }),
    { go: true, frontend: true, browser: true, docker: true, full: true, fileCount: null },
  );
});
