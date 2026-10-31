// A registry-only bridge for `pnpm dev`. The OMC API can stay on loopback even
// when a Docker CPA needs to fetch the public builtin catalog from the host.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

// Match the published local CPA port, then use a gateway that is actually a
// host interface. If the mapping is ambiguous, do not guess another container.
export function selectDockerGateway(cpaBaseURL, containers, hostAddresses) {
  let target;
  try { target = new URL(cpaBaseURL); } catch { return ''; }
  if (!['http:', 'https:'].includes(target.protocol) || !isLocalHost(target.hostname)) return '';
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  const targetHost = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const gateways = new Set();
  for (const container of containers) {
    const bindings = Object.values(container.Ports || {}).flatMap((value) => value || []);
    const matches = bindings.some((binding) => binding.HostPort === port &&
      (!binding.HostIp || binding.HostIp === '0.0.0.0' || binding.HostIp === '::' || binding.HostIp === targetHost ||
        (targetHost === 'localhost' && ['127.0.0.1', '::1'].includes(binding.HostIp))));
    if (!matches) continue;
    for (const network of Object.values(container.Networks || {})) {
      const gateway = network?.Gateway || '';
      if (isIP(gateway) === 4 && hostAddresses.has(gateway)) gateways.add(gateway);
    }
  }
  return gateways.size === 1 ? [...gateways][0] : '';
}

export function discoverDockerGateway(cpaBaseURL) {
  let target;
  try { target = new URL(cpaBaseURL); } catch { return ''; }
  if (!['http:', 'https:'].includes(target.protocol) || !isLocalHost(target.hostname)) return '';
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  if (!/^\d+$/.test(port)) return '';
  try {
    const output = execFileSync('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.ID}}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    });
    const ids = output.trim().split(/\s+/).filter(Boolean);
    const containers = ids.map((id) => JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings}}', id], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    })));
    const hostAddresses = new Set(Object.values(networkInterfaces()).flatMap((entries) => entries || []).map((entry) => entry.address));
    return selectDockerGateway(cpaBaseURL, containers, hostAddresses);
  } catch {
    return '';
  }
}

export function devRegistryPort(apiTarget) {
  const port = Number(new URL(apiTarget).port || 8080);
  return port > 0 && port <= 55535 ? port + 10000 : 18080;
}

// Only a GET to the one public registry is forwarded; credentials and every
// other OMC route stay behind the loopback-only backend listener.
export async function startBuiltinRegistryBridge({ host, port, apiTarget, basePath }) {
  const target = new URL(apiTarget);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('development builtin registry requires an HTTP(S) API target without credentials');
  }
  const registryPath = `${basePath === '/' ? '' : basePath.replace(/\/$/, '')}/plugin-registry/v2.json`;
  const client = target.protocol === 'https:' ? https : http;
  const server = http.createServer((request, response) => {
    let incoming;
    try { incoming = new URL(request.url, 'http://localhost'); } catch {
      response.writeHead(400).end();
      return;
    }
    if (request.method !== 'GET' || incoming.pathname !== registryPath) {
      response.writeHead(404).end();
      return;
    }
    const destination = new URL(registryPath + incoming.search, target);
    const upstream = client.get(destination, { headers: { Accept: 'application/json' }, timeout: 10000 }, (result) => {
      const headers = { 'Cache-Control': 'no-store' };
      if (result.headers['content-type']) headers['Content-Type'] = result.headers['content-type'];
      response.writeHead(result.statusCode || 502, headers);
      result.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on('close', () => upstream.destroy());
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
