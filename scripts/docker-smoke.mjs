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

const UPDATER_NAME = 'oh-my-cpa-updater';
const DOCKER_SOCKET = '/var/run/docker.sock';

function containerExists(name) {
  return executeDocker('ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}') === name;
}

/**
 * A Compose file declares the updater as the same image with another command and no health
 * check of its own, so the image's probe has to answer for that role too.
 */
export async function verifyUpdaterRoleProbe(image) {
  const name = `omc-release-updater-${randomBytes(6).toString('hex')}`;
  const since = new Date().toISOString();
  try {
    executeDocker('run', '-d', '--name', name, '-u', '0', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--health-interval=1s', '--health-start-period=1s', '-v', `${DOCKER_SOCKET}:${DOCKER_SOCKET}`, image, 'updater', 'serve');
    await waitForHealthy(name, since);
    console.log(`PASS ${image}: the image health probe reports a running updater healthy`);
  } finally {
    try { executeDocker('rm', '-f', name); } catch { /* Preserve the original acceptance failure. */ }
  }
}

/**
 * The one command an existing deployment runs, against a console started the way such a
 * deployment starts it: the installer must find the console, create a hardened updater beside
 * it, and leave the two able to talk with no setting on either side.
 */
export async function verifyUpdaterInstall(image) {
  // The installer replaces the container of this name. On a host that really runs one, that
  // would be the operator's updater, so the check declines instead.
  if (containerExists(UPDATER_NAME)) {
    throw new Error(`A ${UPDATER_NAME} container already exists on this host; the updater smoke test would replace it`);
  }
  const suffix = randomBytes(6).toString('hex');
  const consoleName = `omc-release-console-${suffix}`;
  const volume = `omc-release-${suffix}`;
  const secret = randomBytes(24).toString('hex');
  const since = new Date().toISOString();
  try {
    executeDocker('volume', 'create', volume);
    executeDocker('run', '-d', '--name', consoleName, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--health-interval=1s', '--health-start-period=1s', '-p', '127.0.0.1::8080', '-v', `${volume}:/data`,
      '-e', 'OMCPA_LISTEN_ADDR=:8080', '-e', 'OMCPA_BASE_PATH=/omc', '-e', 'OMCPA_DATA_DIR=/data',
      '-e', `OMCPA_MASTER_KEY=${randomBytes(32).toString('hex')}`,
      '-e', 'OMCPA_CPA_BASE_URL=http://127.0.0.1:1', '-e', `OMCPA_CPA_MANAGEMENT_KEY=${secret}`,
      '-e', 'OMCPA_USAGE_INGEST_MODE=off', '-e', 'OMCPA_UPDATE_CHECK_ENABLED=false',
      '-e', 'OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=false', image);
    await waitForHealthy(consoleName, since);
    const consoleBefore = JSON.parse(executeDocker('inspect', consoleName))[0];

    const installedAt = new Date().toISOString();
    executeDocker('run', '--rm', '-u', '0', '-v', `${DOCKER_SOCKET}:${DOCKER_SOCKET}`, image, 'updater', 'install', '--container', consoleName);
    await waitForHealthy(UPDATER_NAME, installedAt);

    const updater = JSON.parse(executeDocker('inspect', UPDATER_NAME))[0];
    assert.equal(updater.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(updater.HostConfig.CapDrop, ['ALL']);
    assert.deepEqual(updater.HostConfig.SecurityOpt, ['no-new-privileges:true']);
    assert.deepEqual(updater.HostConfig.Binds, [`${DOCKER_SOCKET}:${DOCKER_SOCKET}`]);
    assert.deepEqual(updater.HostConfig.PortBindings ?? {}, {}, 'The updater publishes no port');
    assert.equal(updater.HostConfig.RestartPolicy.Name, 'unless-stopped');
    assert.deepEqual(Object.keys(updater.Config.Labels ?? {}).filter(label => label.startsWith('com.docker.compose.')), []);

    // Same image on both sides, so the installer has nothing to upgrade and must leave the
    // console it found in place, joined to the updater's network.
    const consoleAfter = JSON.parse(executeDocker('inspect', consoleName))[0];
    assert.equal(consoleAfter.Id, consoleBefore.Id);
    assert.ok(consoleAfter.NetworkSettings.Networks[UPDATER_NAME], 'The console joins the updater network');
    assert.equal(consoleAfter.HostConfig.ReadonlyRootfs, true);
    assert.ok(!JSON.stringify(consoleAfter.Mounts).includes('docker.sock'), 'The console never holds the socket');

    const origin = `http://${executeDocker('port', consoleName, '8080/tcp')}/omc`;
    const login = await fetch(`${origin}/api/auth/login`, {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: secret})});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${origin}/api/v1/management/system/updater`, {headers: {Cookie: cookie}});
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.state, 'ready', 'The console reaches the updater by name and its derived token is accepted');
    const consoleProduct = status.products.find(product => product.product === 'omc');
    assert.equal(consoleProduct.image, image);
    assert.equal(status.products.find(product => product.product === 'cpa').reason, 'not_a_local_container');
    console.log(`PASS ${image}: updater install — hardened sidecar, console linked without settings, console untouched`);
  } finally {
    for (const cleanup of [['rm', '-f', UPDATER_NAME], ['rm', '-f', consoleName], ['network', 'rm', UPDATER_NAME], ['volume', 'rm', volume]]) {
      try { executeDocker(...cleanup); } catch { /* Preserve the original acceptance failure. */ }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const image = process.argv[2] ?? 'oh-my-cpa:release-test';
  await verifyUpdaterRoleProbe(image);
  await verifyUpdaterInstall(image);
  await verifyDockerImage(image, process.env.RELEASE_TAG ?? 'v0.1.0');
}
