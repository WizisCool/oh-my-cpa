import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { compareGoVersions, parseGoVersion, resolveGoBinary } from './generate-demo-data.mjs';

function readDeployment(name) {
  return YAML.parse(fs.readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8'));
}

function validateTopology(document, isFullStack) {
  assert.deepEqual(Object.keys(document.services).sort(), isFullStack ? ['cpa', 'oh-my-cpa', 'oh-my-cpa-updater'] : ['oh-my-cpa', 'oh-my-cpa-updater']);
  const console = document.services['oh-my-cpa'];
  assert.equal(console.build, undefined);
  assert.equal(console.image, '${OMCPA_IMAGE:-wiziscool/oh-my-cpa:latest}');
  assert.deepEqual(console.ports, ['${OMCPA_BIND:-127.0.0.1:8080}:8080']);
  assert.equal(console.read_only, true);
  assert.equal(console.user, '${OMCPA_USER:-10001:10001}');
  assert.equal(console.environment.OMCPA_LISTEN_ADDR, undefined, 'The binary and image healthcheck already own the :8080 default');
  assert.equal(console.environment.OMCPA_PUBLIC_URL, '${OMCPA_PUBLIC_URL:-}');
  assert.equal(console.environment.OMCPA_TRUSTED_PROXY_CIDRS, '${OMCPA_TRUSTED_PROXY_CIDRS:-}');
  assert.equal(console.environment.OMCPA_USAGE_INGEST_MODE, '${OMCPA_USAGE_INGEST_MODE:-auto}');
  assert.equal(console.environment.OMCPA_DEFAULT_LANGUAGE, '${OMCPA_DEFAULT_LANGUAGE:-}',
    'An empty default is what lets an upgraded install follow each visitor\'s browser without editing a file');
  assert.equal(console.environment.OMCPA_VERSION, undefined);
  assert.equal(console.healthcheck, undefined, 'The image owns its canonical health probe');
  assert.deepEqual(console.volumes, ['${OMCPA_DATA_PATH:-oh-my-cpa-data}:/data']);
  assert.ok(document.volumes && Object.prototype.hasOwnProperty.call(document.volumes, 'oh-my-cpa-data'),
    'Both Compose files must declare the named volume so first-time installs need no host mkdir or chown');
  // The socket is the updater's alone, and the updater has nothing else: no port a host or
  // another network could reach, no data volume, no capability.
  const updater = document.services['oh-my-cpa-updater'];
  assert.equal(updater.image, console.image, 'The updater is the console image, so one pull updates both');
  assert.deepEqual(updater.command, ['updater', 'serve']);
  assert.deepEqual(updater.volumes, ['${DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock']);
  assert.ok(!JSON.stringify(console).includes('docker.sock'), 'The console never holds the socket');
  assert.equal(updater.ports, undefined);
  assert.equal(updater.read_only, true);
  assert.deepEqual(updater.cap_drop, ['ALL']);
  assert.deepEqual(updater.security_opt, ['no-new-privileges:true']);
  assert.equal(updater.healthcheck, undefined, 'The image probe answers for whichever role the container runs');
  assert.deepEqual(updater.networks, console.networks, 'The console finds the updater by service name on its own network');
  if (isFullStack) {
    assert.equal(document.services.cpa.image, '${CPA_IMAGE:-eceasy/cli-proxy-api:latest}');
    assert.deepEqual(document.services.cpa.ports, ['${CPA_BIND:-127.0.0.1:8317}:8317']);
    assert.deepEqual(document.services.cpa.volumes, [
      '${CPA_CONFIG_PATH:-./config.yaml}:/CLIProxyAPI/config.yaml',
      '${CPA_AUTH_PATH:-./auths}:/root/.cli-proxy-api',
      '${CPA_LOG_PATH:-./logs}:/CLIProxyAPI/logs',
      '${CPA_PLUGIN_PATH:-./plugins}:/CLIProxyAPI/plugins',
    ]);
    assert.equal(console.depends_on.cpa.condition, 'service_healthy');
  } else {
    assert.deepEqual(console.extra_hosts, ['host.docker.internal:host-gateway']);
    assert.equal(document.networks.default.external, '${OMCPA_NETWORK_EXTERNAL:-false}');
  }
}

test('Compose files install latest images through loopback, default to named volume storage and preserve collection choice', () => {
  validateTopology(readDeployment('compose.full.yml'), true);
  validateTopology(readDeployment('compose.omc.yml'), false);
  const broken = readDeployment('compose.full.yml');
  broken.services['oh-my-cpa'].ports = ['0.0.0.0:8080:8080'];
  assert.throws(() => validateTopology(broken, true));
  const missingNamedVolume = readDeployment('compose.omc.yml');
  delete missingNamedVolume.volumes;
  assert.throws(() => validateTopology(missingNamedVolume, false));
  const rootConsole = readDeployment('compose.full.yml');
  rootConsole.services['oh-my-cpa'].user = '0:0';
  assert.throws(() => validateTopology(rootConsole, true));
  for (const mutate of [
    (updater) => { updater.ports = ['8090:8090']; },
    (updater) => { updater.cap_drop = []; },
    (updater) => { updater.image = 'wiziscool/oh-my-cpa:latest'; },
    (updater) => { updater.command = ['updater']; },
  ]) {
    const exposed = readDeployment('compose.omc.yml');
    mutate(exposed.services['oh-my-cpa-updater']);
    assert.throws(() => validateTopology(exposed, false));
  }
  const socketInConsole = readDeployment('compose.full.yml');
  socketInConsole.services['oh-my-cpa'].volumes = ['/var/run/docker.sock:/var/run/docker.sock'];
  assert.throws(() => validateTopology(socketInConsole, true));
  for (const service of ['oh-my-cpa', 'cpa']) {
    const pinned = readDeployment('compose.full.yml');
    pinned.services[service].image = pinned.services[service].image.replace(':latest', ':v0.1.0');
    assert.throws(() => validateTopology(pinned, true));
  }
});
test('new gateway bootstrap uses v8, enables usage and has no reusable client secret', () => {
  const config = readDeployment('cpa.config.example.yaml');
  assert.equal(config['config-version'], 8);
  assert.equal(config.server.port, 8317);
  assert.equal(config.management['allow-remote'], true);
  assert.equal(config.management['secret-key'], '');
  assert.deepEqual(config.access['api-keys'], []);
  assert.equal(config.observability.usage['usage-statistics-enabled'], true);
});

test('demo generator skips too-old PATH go and isolates cached SDK GOROOT', async () => {
  assert.ok(compareGoVersions(parseGoVersion('go version go1.27.3 linux/amd64'), parseGoVersion('go1.26')) > 0);
  assert.ok(compareGoVersions(parseGoVersion('go version go1.24.9 linux/amd64'), parseGoVersion('go1.26.0')) < 0);
  assert.equal(compareGoVersions(parseGoVersion('go version go1.26.0 linux/amd64'), parseGoVersion('go1.26')), 0);

  if (process.platform === 'win32') return;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-demo-go-'));
  try {
    const oldBinDir = path.join(sandbox, 'old-bin');
    const sdkBinDir = path.join(sandbox, 'tmp', 'go-sdk', 'go', 'bin');
    fs.mkdirSync(oldBinDir, { recursive: true });
    fs.mkdirSync(sdkBinDir, { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'go.mod'), 'module example.com/test\n\ngo 1.26.0\n');
    fs.writeFileSync(
      path.join(sandbox, 'scripts', 'tools-versions.json'),
      JSON.stringify({ go: { version: '1.27.3', archives: {} } }),
    );
    const fakeOldGo = path.join(oldBinDir, 'go');
    fs.writeFileSync(fakeOldGo, '#!/bin/sh\necho "go version go1.24.9 linux/amd64"\n', { mode: 0o755 });
    const fakeCachedGo = path.join(sdkBinDir, 'go');
    fs.writeFileSync(fakeCachedGo, '#!/bin/sh\necho "go version go1.27.3 linux/amd64"\n', { mode: 0o755 });

    const resolved = await resolveGoBinary(sandbox, { env: { ...process.env, PATH: oldBinDir } });
    assert.equal(resolved.bin, fakeCachedGo);
    assert.equal(resolved.env.GOROOT, path.join(sandbox, 'tmp', 'go-sdk', 'go'));
    assert.equal(resolved.env.GOTOOLCHAIN, 'local');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
