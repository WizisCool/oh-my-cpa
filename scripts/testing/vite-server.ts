import { createServer } from '../../web/node_modules/vite/dist/node/index.js';

const owner = process.env.OMC_PROBE_OWNER;
if (!owner) throw new Error('A probe server requires an invocation owner');
const ids: string[] = JSON.parse(process.env.OMC_PROBE_IDS ?? '[]');
const modules = [
  '/src/main.tsx',
  ...(ids.some(id => id.startsWith('agent')) ? ['/src/pages/agent/AgentPage.tsx'] : []),
  ...(ids.some(id => id.startsWith('playground')) ? ['/src/pages/playground/PlaygroundPage.tsx'] : []),
];
// Vite rewrites optimized chunk names and metadata. Each live server needs its
// own cache, including two independent probe runs, not just the developer's Vite.
const cacheDir = process.env.OMC_PROBE_CACHE_DIR;
if (!cacheDir) throw new Error('A probe server requires an invocation-owned cache directory');
const server = await createServer({
  cacheDir,
  server: {
    host: '127.0.0.1', port: Number(process.argv[2] ?? '0'), strictPort: true,
    headers: { 'X-OMC-Probe-Owner': owner },
    warmup: { clientFiles: modules.map(url => `.${url}`) },
  },
});
try {
  // Vite 6's listen(0) selects its default port. Binding the exposed HTTP
  // server directly lets the OS allocate a port without a reserve/rebind race.
  const listener = server.httpServer;
  if (!listener) throw new Error('Probe server has no HTTP listener');
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(Number(process.argv[2] ?? '0'), '127.0.0.1', () => {
      listener.removeListener('error', reject);
      resolve();
    });
  });
  await Promise.all(modules.map(async url => {
    if (!await server.transformRequest(url)) throw new Error(`Cannot prepare probe module: ${url}`);
  }));
  await server.waitForRequestsIdle();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Probe server has no TCP address');
  // Native Playwright captures the URL only from this child's owned stdout,
  // after bind and cold transforms. No port reservation or HTTP readiness race.
  console.log(`OMC_PROBE_READY:${owner} http://127.0.0.1:${address.port}/omc`);
} catch (error) {
  await server.close();
  throw error;
}
