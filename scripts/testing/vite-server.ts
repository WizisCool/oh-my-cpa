import { createServer } from '../../web/node_modules/vite/dist/node/index.js';
import { parseProbePort } from '../acceptance/probe-options.mjs';

const owner = process.env.OMC_PROBE_OWNER;
if (!owner) throw new Error('A probe server requires an invocation owner');
const ids: string[] = JSON.parse(process.env.OMC_PROBE_IDS ?? '[]');
const modules = process.env.OMC_PROBE_CATALOG === 'harness' ? [] : [
  '/src/main.tsx',
  ...(ids.some(id => id.startsWith('agent')) ? ['/src/pages/agent/AgentPage.tsx'] : []),
  ...(ids.some(id => id.startsWith('playground')) ? ['/src/pages/playground/PlaygroundPage.tsx'] : []),
];
const server = await createServer({
  server: {
    host: '127.0.0.1', port: parseProbePort(process.argv[2]), strictPort: true,
    headers: { 'X-OMC-Probe-Owner': owner },
    warmup: { clientFiles: modules.map(url => `.${url}`) },
  },
});
await server.listen();
// Keep cold source transformation in server startup, not an interaction budget.
await Promise.all(modules.map(async url => {
  if (!await server.transformRequest(url)) throw new Error(`Cannot prepare probe module: ${url}`);
}));
if (modules.length) await server.waitForRequestsIdle();
// Readiness comes from this child's pipe, after its strict bind. A foreign HTTP
// response cannot win a readiness race, even if it serves the same application.
console.log(`OMC_PROBE_READY:${owner}`);
