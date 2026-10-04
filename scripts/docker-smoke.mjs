import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function executeDocker(...args) {
  try {
    return execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  } catch (error) {
    // child_process errors echo argv, which can contain freshly generated container secrets.
    throw new Error(`Docker ${args[0]} failed (status ${error.status ?? error.code ?? 'unknown'})`);
  }
}

async function waitForHealthy(container, since) {
  const controller = new AbortController();
  const events = spawn('docker', ['events', '--since', since, '--filter', `container=${container}`,
    '--filter', 'event=health_status', '--format', '{{.Action}}'], {signal: controller.signal});
  let diagnostics = '';
  events.stderr.on('data', bytes => { diagnostics += bytes.toString(); });
  try {
    await new Promise((resolve, reject) => {
      const deadline = AbortSignal.timeout(45_000);
      deadline.addEventListener('abort', () => reject(new Error('Container did not become healthy')), {once: true});
      events.once('error', reject);
      events.once('exit', () => reject(new Error(`Health event stream ended before readiness: ${diagnostics}`)));
      events.stdout.on('data', bytes => {
        const status = bytes.toString();
        if (status.includes('health_status: healthy')) resolve();
        if (status.includes('health_status: unhealthy')) reject(new Error('Container health probe failed'));
      });
    });
  } finally {
    controller.abort();
  }
}

export async function verifyDockerImage(image, version) {
  const metadata = JSON.parse(executeDocker('image', 'inspect', image))[0];
  assert.equal(metadata.Config.User, '10001:10001');
  assert.equal(metadata.Config.Labels['org.opencontainers.image.version'], version);
  const secret = randomBytes(24).toString('hex');
  for (const [rawPath, listenPort] of [['omc', '8080'], ['/', '8080'], ['/tools/omc/', '8081']]) {
    const volume = `omc-release-${randomBytes(6).toString('hex')}`;
    const since = new Date().toISOString();
    let container;
    try {
      executeDocker('volume', 'create', volume);
      container = executeDocker('create', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--health-interval=1s', '--health-start-period=1s', '-p', `127.0.0.1::${listenPort}`, '-v', `${volume}:/data`,
        '-e', `OMCPA_LISTEN_ADDR=:${listenPort}`, '-e', `OMCPA_BASE_PATH=${rawPath}`, '-e', 'OMCPA_DATA_DIR=/data',
        '-e', `OMCPA_MASTER_KEY=${randomBytes(32).toString('hex')}`,
        '-e', 'OMCPA_CPA_BASE_URL=http://127.0.0.1:1', '-e', `OMCPA_CPA_MANAGEMENT_KEY=${secret}`,
        '-e', 'OMCPA_USAGE_INGEST_MODE=off', '-e', 'OMCPA_UPDATE_CHECK_ENABLED=false',
        '-e', 'OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=false', image);
      executeDocker('start', container);
      await waitForHealthy(container, since);
      const address = executeDocker('port', container, `${listenPort}/tcp`);
      const basePath = rawPath === '/' ? '' : `/${rawPath.replace(/^\/+|\/+$/g, '')}`;
      const origin = `http://${address}${basePath}`;
      const healthResponse = await fetch(`${origin}/api/healthz`);
      const health = await healthResponse.json();
      assert.equal(healthResponse.status, 200);
      assert.equal(health.database_status, 'ok');
      assert.equal(health.version, version);
      assert.equal(health.status, 'degraded');
      assert.equal(health.cpa_connected, false);
      const page = await fetch(`${origin}/`);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.ok(html.includes(version), 'Embedded runtime configuration must name the release');
      const login = await fetch(`${origin}/api/auth/login`, {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: secret})});
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const response = await fetch(`${origin}/api/v1/management/system`, {headers: {Cookie: cookie}});
      assert.equal(response.status, 200);
      const system = await response.json();
      assert.equal(system.omc_version.running_version, version);
      assert.equal(system.omc_version.state, 'indeterminate');
      const state = JSON.parse(executeDocker('inspect', container))[0];
      assert.equal(state.HostConfig.ReadonlyRootfs, true);
      assert.equal(state.State.Health.Status, 'healthy');
      executeDocker('exec', container, 'sh', '-c', 'test -s /data/oh-my-cpa.db && test -w /data');
      console.log(`PASS ${image}: ${rawPath} — image health, SQLite, login, embedded SPA and version ${version}`);
    } finally {
      if (container) {
        try { executeDocker('rm', '-f', container); } catch { /* Preserve the original acceptance failure. */ }
      }
      try { executeDocker('volume', 'rm', volume); } catch { /* A failed cleanup must not disclose container environment. */ }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyDockerImage(process.argv[2] ?? 'oh-my-cpa:release-test', process.env.RELEASE_TAG ?? 'v0.1.0');
}
