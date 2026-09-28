import assert from 'node:assert/strict';
import { devNull } from 'node:os';
import fs from 'node:fs';
import test from 'node:test';
import { isolatedAppEnvironment } from './acceptance/environment.mjs';

test('fixture environment cannot inherit operator application settings or transport proxies', () => {
  const inherited = {
    PATH: '/fixture/bin', SystemRoot: 'fixture-root', HOME: '/fixture/home',
    OMCPA_ENV_FILE: '/operator/config.env', OMCPA_DEMO_MODE: 'true',
    OMCPA_CPA_BASE_URL: 'https://operator.example.test', OMCPA_FUTURE_OPTION: 'enabled',
    OMCPA_MASTER_KEY: 'operator-value', PORT: '8080',
    HTTPS_PROXY: 'https://proxy.example.test', http_proxy: 'http://proxy.example.test',
    ALL_PROXY: 'http://proxy.example.test', no_proxy: '*',
  };
  const before = { ...inherited };
  assert.deepEqual(isolatedAppEnvironment({ OMCPA_CPA_BASE_URL: 'http://127.0.0.1:9001' }, inherited), {
    PATH: inherited.PATH, SystemRoot: inherited.SystemRoot, HOME: inherited.HOME,
    OMCPA_CPA_BASE_URL: 'http://127.0.0.1:9001', OMCPA_ENV_FILE: devNull,
  });
  assert.deepEqual(inherited, before);
});

test('explicit fixture proxies survive but dotenv remains an empty platform file', () => {
  const environment = isolatedAppEnvironment({
    OMCPA_DEMO_MODE: 'true', HTTPS_PROXY: 'http://127.0.0.1:1', OMCPA_ENV_FILE: '/operator/config.env',
  }, {});
  assert.equal(environment.OMCPA_DEMO_MODE, 'true');
  assert.equal(environment.HTTPS_PROXY, 'http://127.0.0.1:1');
  assert.equal(environment.OMCPA_ENV_FILE, devNull);
  assert.equal(fs.readFileSync(environment.OMCPA_ENV_FILE, 'utf8'), '');
});
