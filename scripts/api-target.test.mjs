// Regression tests for the dev proxy target resolver.
//
// scripts/api-target.mjs duplicates a slice of internal/config's dotenv
// semantics, so the cases here mirror dotenv_test.go and config_test.go: file
// precedence, quoting, inline comments, and the documented defaults.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveApiTarget, resolveListenAddr } from './api-target.mjs';

const ENV_KEYS = ['OMCPA_LISTEN_ADDR', 'OMCPA_ENV_FILE', 'OMCPA_API_TARGET'];

// `OMCPA_LISTEN_ADDR` follows os.LookupEnv, so "absent" and "set to empty" are
// different states and the harness has to restore both.
function withEnvironment(values, run) {
  const saved = new Map(ENV_KEYS.map((key) => [key, Object.hasOwn(process.env, key) ? process.env[key] : undefined]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withRoot(createDotEnv, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-api-target-'));
  try {
    if (createDotEnv) createDotEnv(root);
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function dotEnvFile(contents) {
  return (root) => fs.writeFileSync(path.join(root, '.env'), contents);
}

test('falls back to the documented default without a dotenv file', () => {
  withEnvironment({}, () =>
    withRoot(undefined, (root) => {
      assert.equal(resolveListenAddr(root), '127.0.0.1:8080');
      assert.equal(resolveApiTarget(root), 'http://127.0.0.1:8080');
    }),
  );
});

test('reads the configured listen address from .env', () => {
  withEnvironment({}, () =>
    withRoot(dotEnvFile('OMCPA_LISTEN_ADDR=127.0.0.1:9000\n'), (root) => {
      assert.equal(resolveListenAddr(root), '127.0.0.1:9000');
      assert.equal(resolveApiTarget(root), 'http://127.0.0.1:9000');
    }),
  );
});

test('accepts whitespace around the separator, quotes and inline comments', () => {
  const cases = [
    ['OMCPA_LISTEN_ADDR = 127.0.0.1:9001\n', '127.0.0.1:9001'],
    ['OMCPA_LISTEN_ADDR="127.0.0.1:9002"\n', '127.0.0.1:9002'],
    ["export OMCPA_LISTEN_ADDR='127.0.0.1:9003'\n", '127.0.0.1:9003'],
    ['OMCPA_LISTEN_ADDR=127.0.0.1:9004 # local api\n', '127.0.0.1:9004'],
    ['OMCPA_LISTEN_ADDR="127.0.0.1:9005"  # dev\n', '127.0.0.1:9005'],
    ['OMCPA_CPA_BASE_URL=http://127.0.0.1:8317\nOMCPA_LISTEN_ADDR=127.0.0.1:9006\n', '127.0.0.1:9006'],
    ['OMCPA_LISTEN_ADDR=127.0.0.1:9007\nOMCPA_LISTEN_ADDR=127.0.0.1:9008\n', '127.0.0.1:9007'],
  ];
  for (const [file, expected] of cases) {
    withEnvironment({}, () => withRoot(dotEnvFile(file), (root) => assert.equal(resolveListenAddr(root), expected, file)));
  }
});

test('a real environment variable wins over the file', () => {
  withEnvironment({ OMCPA_LISTEN_ADDR: '10.0.0.7:9010' }, () =>
    withRoot(dotEnvFile('OMCPA_LISTEN_ADDR=127.0.0.1:9000\n'), (root) => {
      assert.equal(resolveApiTarget(root), 'http://10.0.0.7:9010');
    }),
  );
});

test('an empty or blank environment variable suppresses the file and uses the default', () => {
  for (const value of ['', '   ']) {
    withEnvironment({ OMCPA_LISTEN_ADDR: value }, () =>
      withRoot(dotEnvFile('OMCPA_LISTEN_ADDR=127.0.0.1:9000\n'), (root) => {
        assert.equal(resolveListenAddr(root), '127.0.0.1:8080');
      }),
    );
  }
});

test('OMCPA_ENV_FILE selects another dotenv file, absolute or root-relative', () => {
  withEnvironment({}, () =>
    withRoot((root) => fs.writeFileSync(path.join(root, 'dev.env'), 'OMCPA_LISTEN_ADDR=127.0.0.1:9011\n'), (root) => {
      const absolute = withEnvironment({ OMCPA_ENV_FILE: path.join(root, 'dev.env') }, () => resolveApiTarget(root));
      const relative = withEnvironment({ OMCPA_ENV_FILE: 'dev.env' }, () => resolveApiTarget(root));
      assert.equal(absolute, 'http://127.0.0.1:9011');
      assert.equal(relative, 'http://127.0.0.1:9011');
    }),
  );
});

test('normalises wildcard, port-only and IPv6 listeners into proxy targets', () => {
  const cases = [
    ['0.0.0.0:7000', 'http://127.0.0.1:7000'],
    [':7002', 'http://127.0.0.1:7002'],
    ['[::1]:7003', 'http://[::1]:7003'],
    ['localhost:7004', 'http://localhost:7004'],
    ['localhost', 'http://localhost:8080'],
  ];
  for (const [listenAddr, expected] of cases) {
    withEnvironment({ OMCPA_LISTEN_ADDR: listenAddr }, () =>
      withRoot(undefined, (root) => assert.equal(resolveApiTarget(root), expected, listenAddr)),
    );
  }
});

test('OMCPA_API_TARGET overrides the resolved address', () => {
  withEnvironment({ OMCPA_LISTEN_ADDR: '127.0.0.1:9000', OMCPA_API_TARGET: 'http://10.0.0.9:9500' }, () =>
    withRoot(undefined, (root) => assert.equal(resolveApiTarget(root), 'http://10.0.0.9:9500')),
  );
});

test('reports malformed and unreadable dotenv files instead of guessing', () => {
  withEnvironment({}, () =>
    withRoot(dotEnvFile('OMCPA_LISTEN_ADDR="127.0.0.1:9000\n'), (root) => {
      assert.throws(() => resolveListenAddr(root), /unterminated quoted value for OMCPA_LISTEN_ADDR/);
    }),
  );
  withEnvironment({}, () =>
    withRoot((root) => fs.mkdirSync(path.join(root, '.env')), (root) => {
      assert.throws(() => resolveListenAddr(root), /cannot read dotenv file .*EISDIR/);
    }),
  );
});
