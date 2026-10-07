import { createServer } from '../../web/node_modules/vite/dist/node/index.js';

const server = await createServer({
  server: {host:'127.0.0.1',port:Number(process.argv[2]),strictPort:true,headers:{'X-OMC-Probe-Owner':process.env.OMC_PROBE_OWNER}},
});
await server.listen();
