import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

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
  assert.equal(console.user, '10001:10001');
  assert.equal(console.environment.OMCPA_TRUSTED_PROXY_CIDRS, '${OMCPA_TRUSTED_PROXY_CIDRS:-}');
  assert.equal(console.environment.OMCPA_USAGE_INGEST_MODE, '${OMCPA_USAGE_INGEST_MODE:-auto}');
  assert.equal(console.environment.OMCPA_VERSION, undefined);
  assert.equal(console.healthcheck, undefined, 'The image owns its canonical health probe');
  assert.equal(console.volumes.length, 1, 'Installers must not need to mount helper scripts');
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
    assert.equal(console.depends_on.cpa.condition, 'service_healthy');
  } else {
    assert.deepEqual(console.extra_hosts, ['host.docker.internal:host-gateway']);
    assert.equal(document.networks.default.external, '${OMCPA_NETWORK_EXTERNAL:-false}');
  }
}

test('Compose files install latest images through loopback and preserve collection choice', () => {
  validateTopology(readDeployment('compose.full.yml'), true);
  validateTopology(readDeployment('compose.omc.yml'), false);
  const broken = readDeployment('compose.full.yml');
  broken.services['oh-my-cpa'].ports = ['0.0.0.0:8080:8080'];
  assert.throws(() => validateTopology(broken, true));
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
