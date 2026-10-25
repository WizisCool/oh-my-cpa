import { createServer } from '../../web/node_modules/vite/dist/node/index.js';

const owner = process.env.OMC_PROBE_OWNER;
if (!owner) throw new Error('A probe server requires an invocation owner');
const ids: string[] = JSON.parse(process.env.OMC_PROBE_IDS ?? '[]');
const modules = [
  '/src/main.tsx',
  ...(ids.some(id => id.startsWith('agent')) ? ['/src/pages/agent/AgentPage.tsx'] : []),
  ...(ids.some(id => id.startsWith('playground')) ? ['/src/pages/playground/PlaygroundPage.tsx'] : []),
];
/**
 * A probe run pre-bundles into its own directory, not the developer's `node_modules/.vite`.
 *
 * Both are Vite caches, but they belong to different lifecycles. Pre-bundling writes new chunk
 * names and rewrites `_metadata.json`, and a `pnpm dev` session that is already open keeps serving
 * the graph it built earlier - so a verification run against the default directory leaves that
 * session mixing two copies of a dependency, which fails in the middle of one of them (a Prism
 * grammar reading `Prism.languages.javascript` from another refractor instance threw
 * `Cannot read properties of undefined (reading 'source')` on the Agent route). Keeping the probe
 * cache separate means verification cannot break a session somebody is using, and the two
 * lifecycles no longer invalidate each other.
 */
const cacheDir = 'node_modules/.vite-probes';
const server = await createServer({
  cacheDir,
  server: {
    host: '127.0.0.1', port: Number(process.argv[2]), strictPort: true,
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
