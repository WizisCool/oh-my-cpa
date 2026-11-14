import assert from 'node:assert/strict';
import test from 'node:test';
import { decideRunScope, scopeOf } from './ci-scope.mjs';

test('docs-only and review config changes skip heavy Go, frontend, browser, docker, and docs-site lanes', () => {
  assert.deepEqual(scopeOf(['docs/dev/testing.md', '.coderabbit.yaml', 'lychee.toml']), {
    go: false,
    frontend: false,
    browser: false,
    docker: false,
    docs: false,
  });
});

test('public docs, landing page, and Fumadocs app changes trigger docs-site only without Go, SPA tests, or browser acceptance', () => {
  for (const file of [
    'README.md',
    'README.zh-CN.md',
    'docs/install.md',
    'docs/zh/operations.md',
    'deploy/site/landing/index.html',
    'deploy/site/api-reference/index.html',
    'deploy/site/_headers',
    'deploy/site/docs/src/lib/source.ts',
  ]) {
    assert.deepEqual(scopeOf([file]), {
      go: false,
      frontend: false,
      browser: false,
      docker: false,
      docs: true,
    }, file);
  }
});

test('Go backend changes trigger go + browser, and API/migration changes also verify demo parity in frontend', () => {
  assert.deepEqual(scopeOf(['internal/quota/forecast.go']), {
    go: true,
    frontend: false,
    browser: true,
    docker: false,
    docs: false,
  });
  assert.deepEqual(scopeOf(['internal/api/dashboard.go']), {
    go: true,
    frontend: true,
    browser: true,
    docker: false,
    docs: false,
  });
  assert.deepEqual(scopeOf(['migrations/020_example.sql']), {
    go: true,
    frontend: true,
    browser: true,
    docker: false,
    docs: false,
  });
  assert.deepEqual(scopeOf(['docs/openapi/swagger.json']), {
    go: true,
    frontend: true,
    browser: false,
    docker: false,
    docs: true,
  });
});

test('frontend-only changes skip Go unit tests while keeping browser and frontend gates', () => {
  assert.deepEqual(scopeOf(['web/src/pages/Dashboard.tsx']), {
    go: false,
    frontend: true,
    browser: true,
    docker: false,
    docs: false,
  });
  // Shared API contracts and web/public assets are also read by Go tests.
  assert.deepEqual(scopeOf(['scripts/acceptance/contracts/warmup.json']), {
    go: true,
    frontend: true,
    browser: true,
    docker: false,
    docs: false,
  });
  assert.deepEqual(scopeOf(['web/index.html']), {
    go: true,
    frontend: true,
    browser: true,
    docker: false,
    docs: false,
  });
  // Vite build plugins and demo/site-worker scripts run frontend + browser checks.
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
      docs: false,
    }, script);
  }
  for (const siteRuntime of [
    'scripts/build-site.mjs',
    'deploy/site/worker.mjs',
    'deploy/site/wrangler.jsonc',
  ]) {
    assert.deepEqual(scopeOf([siteRuntime]), {
      go: false,
      frontend: true,
      browser: true,
      docker: false,
      docs: true,
    }, siteRuntime);
  }
  for (const docsSyncScript of ['scripts/sync-docs-site.mjs', 'scripts/build-site.test.mjs']) {
    assert.deepEqual(scopeOf([docsSyncScript]), {
      go: false,
      frontend: false,
      browser: false,
      docker: false,
      docs: true,
    }, docsSyncScript);
  }
});

test('container, lockfile, CI, and unrecognized changes trigger docker or full verification conservatively', () => {
  assert.deepEqual(scopeOf(['Dockerfile']), {
    go: false,
    frontend: false,
    browser: false,
    docker: true,
    docs: false,
  });
  assert.deepEqual(scopeOf(['pnpm-lock.yaml']), {
    go: true,
    frontend: true,
    browser: true,
    docker: true,
    docs: true,
  });
  assert.deepEqual(scopeOf(['.github/workflows/ci.yml']), {
    go: true,
    frontend: true,
    browser: true,
    docker: true,
    docs: true,
  });
  assert.deepEqual(scopeOf(['unexpected/new-top-level.txt']), {
    go: true,
    frontend: true,
    browser: true,
    docker: true,
    docs: true,
  });
});

test('decideRunScope handles main pushes, full-ci labels, and base-diff failures safely', () => {
  const diffReturning = (files) => () => `${files.join('\0')}\0`;

  // Ordinary main push runs full verification without paying docker cost unless container inputs changed.
  assert.deepEqual(
    decideRunScope({ EVENT: 'push', REF: 'refs/heads/main', BASE: 'abc123' }, diffReturning(['internal/quota/a.go'])),
    { go: true, frontend: true, browser: true, docker: false, docs: true, full: true, fileCount: 1 },
  );
  assert.deepEqual(
    decideRunScope({ EVENT: 'push', REF: 'refs/heads/main', BASE: 'abc123' }, diffReturning(['Dockerfile'])),
    { go: true, frontend: true, browser: true, docker: true, docs: true, full: true, fileCount: 1 },
  );

  // Full-ci label forces every lane including docker and full browser acceptance.
  assert.deepEqual(
    decideRunScope({ EVENT: 'pull_request', BASE: 'abc123', LABELS: '["full-ci"]' }, diffReturning(['README.md'])),
    { go: true, frontend: true, browser: true, docker: true, docs: true, full: true, fileCount: null },
  );

  // Missing or zero base SHA, or failing git diff, fails closed to full verification.
  assert.deepEqual(
    decideRunScope({ EVENT: 'pull_request', BASE: '0000000000000000000000000000000000000000' }),
    { go: true, frontend: true, browser: true, docker: true, docs: true, full: true, fileCount: null },
  );
  assert.deepEqual(
    decideRunScope({ EVENT: 'pull_request', BASE: 'abc123' }, () => { throw new Error('git diff failed'); }),
    { go: true, frontend: true, browser: true, docker: true, docs: true, full: true, fileCount: null },
  );
});
