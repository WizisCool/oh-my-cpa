import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import test from 'node:test';

const PLAYWRIGHT = createRequire(import.meta.url).resolve('@playwright/test/cli');

test('native server startup refuses an occupied port before browser admission', async () => {
  const server = net.createServer(socket => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await assert.rejects(promisify(execFile)(process.execPath, [PLAYWRIGHT, 'test', '--config', 'scripts/testing/probe-config.ts'], {
      env: { ...process.env, OMC_PROBE_PORT: String(address.port), OMC_PROBE_PHASE: 'shared', OMC_PROBE_CATALOG: 'probes', OMC_PROBE_IDS: '["route-render-error"]' },
    }), (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.match(`${failure.stdout}${failure.stderr}`, /already in use/);
      assert.doesNotMatch(failure.stdout, /Running 1 test/);
      return true;
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
