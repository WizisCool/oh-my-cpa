// Keeps the Vite development entry consistent with the configured console mount.
//
// Vite only serves documents under its `base`, which ends in a slash, so a bare
// configured prefix gets Vite's 404 hint while the Go server redirects the same
// address. Development follows the server so a hand-typed or bookmarked prefix opens
// the console in both. A root base has no bare path to redirect.

import crypto from 'node:crypto';
import path from 'node:path';

export const DEV_HMR_STATE_SUFFIX = '__omc_vite_hmr_state';
const DEV_HMR_BOOT_GLOBAL = '__OMC_VITE_HMR_BOOT__';
const DEV_HMR_PROBE_TIMEOUT_MS = 2500;
const DEV_HMR_RECONNECT_TIMEOUT_MS = 5000;

const VITE_CLIENT_TRANSPORT_SNIPPET = 'const createWebSocketModuleRunnerTransport = (options) => {';

const VITE_CLIENT_CLOSE_SNIPPET = `          socket.addEventListener("close", async () => {
            if (!isOpened) {
              reject(new Error("WebSocket closed without opened."));
              return;
            }
            onMessage({
              type: "custom",
              event: "vite:ws:disconnect",
              data: { webSocket: socket }
            });
            onDisconnection();
          });
        });
      }
      onMessage({
        type: "custom",
        event: "vite:ws:connect",
        data: { webSocket: socket }
      });`;

const VITE_CLIENT_CONNECT_SNIPPET = 'transport.connect(createHMRHandler(handleMessage));';

const VITE_CLIENT_DISCONNECT_SNIPPET = `    case "custom": {
      await hmrClient.notifyListeners(payload.event, payload.data);
      if (payload.event === "vite:ws:disconnect") {
        if (hasDocument && !willUnload) {
          console.log(\`[vite] server connection lost. Polling for restart...\`);
          const socket = payload.data.webSocket;
          const url = new URL(socket.url);
          url.search = "";
          await waitForSuccessfulPing(url.href);
          location.reload();
        }
      }
      break;
    }`;

/**
 * Patches Vite's dev-only `@vite/client` so a mobile browser whose WebSocket was
 * suspended in the background reconnects HMR in-place instead of forcing
 * `location.reload()` when the dev server neither restarted nor saw any source edit
 * since the HTML document booted. Returns `{ code, patched }` and leaves the source
 * untouched if Vite's client template no longer matches.
 */
export function patchViteClientForBackgroundResume(code, stateSuffix = DEV_HMR_STATE_SUFFIX) {
  if (
    typeof code !== 'string' ||
    !code.includes(VITE_CLIENT_TRANSPORT_SNIPPET) ||
    !code.includes(VITE_CLIENT_CLOSE_SNIPPET) ||
    !code.includes(VITE_CLIENT_CONNECT_SNIPPET) ||
    !code.includes(VITE_CLIENT_DISCONNECT_SNIPPET)
  ) {
    return { code, patched: false };
  }

  let next = code.replace(
    VITE_CLIENT_TRANSPORT_SNIPPET,
    `let omcConnectedGen = 0;
let omcIsSocketOpen = false;
${VITE_CLIENT_TRANSPORT_SNIPPET}`,
  );

  next = next.replace(
    VITE_CLIENT_CLOSE_SNIPPET,
    `          socket.addEventListener("close", async () => {
            clearInterval(pingIntervalId);
            if (!isOpened) {
              reject(new Error("WebSocket closed without opened."));
              return;
            }
            omcIsSocketOpen = false;
            onMessage({
              type: "custom",
              event: "vite:ws:disconnect",
              data: { webSocket: socket }
            });
            onDisconnection();
          });
        });
      }
      omcIsSocketOpen = true;
      omcConnectedGen += 1;
      onMessage({
        type: "custom",
        event: "vite:ws:connect",
        data: { webSocket: socket }
      });`,
  );

  next = next.replace(
    VITE_CLIENT_CONNECT_SNIPPET,
    `const omcHmrStatePath = \`\${base}${stateSuffix}\`;
let omcReconnecting = false;
function omcReadBootState() {
  const boot = typeof window !== "undefined" ? window.${DEV_HMR_BOOT_GLOBAL} : null;
  if (!boot || typeof boot.instanceId !== "string" || typeof boot.revision !== "number") return null;
  return boot;
}
async function omcFetchHmrState() {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ${DEV_HMR_PROBE_TIMEOUT_MS}) : null;
  try {
    const response = await fetch(omcHmrStatePath, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) return null;
    const state = await response.json();
    if (!state || typeof state.instanceId !== "string" || typeof state.revision !== "number") return null;
    return state;
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
async function omcMatchesBootState() {
  const boot = omcReadBootState();
  if (!boot) return false;
  const latest = await omcFetchHmrState();
  if (!latest) return false;
  return latest.instanceId === boot.instanceId && latest.revision === boot.revision;
}
const omcHmrHandler = createHMRHandler(handleMessage);
transport.connect(omcHmrHandler);`,
  );

  next = next.replace(
    VITE_CLIENT_DISCONNECT_SNIPPET,
    `    case "custom": {
      await hmrClient.notifyListeners(payload.event, payload.data);
      if (payload.event === "vite:ws:disconnect") {
        if (hasDocument && !willUnload) {
          if (omcReconnecting) break;
          omcReconnecting = true;
          console.log(\`[vite] server connection lost. Polling for restart...\`);
          const socket = payload.data.webSocket;
          const url = new URL(socket.url);
          url.search = "";
          if (document.visibilityState !== "visible") {
            await waitForWindowShow();
          }
          await waitForSuccessfulPing(url.href);
          if (await omcMatchesBootState()) {
            const connectedGenBefore = omcConnectedGen;
            setTimeout(() => {
              let settled = false;
              const failAndReload = () => {
                if (settled) return;
                settled = true;
                clearTimeout(reconnectDeadline);
                omcReconnecting = false;
                location.reload();
              };
              const reconnectDeadline = setTimeout(failAndReload, ${DEV_HMR_RECONNECT_TIMEOUT_MS});
              void transport.connect(omcHmrHandler).then(
                async () => {
                  if (settled) return;
                  const connectedGenAfter = omcConnectedGen;
                  const reconnected = omcIsSocketOpen && connectedGenAfter !== connectedGenBefore;
                  if (
                    !reconnected ||
                    !(await omcMatchesBootState()) ||
                    settled ||
                    !omcIsSocketOpen ||
                    omcConnectedGen !== connectedGenAfter
                  ) {
                    failAndReload();
                    return;
                  }
                  settled = true;
                  clearTimeout(reconnectDeadline);
                  omcReconnecting = false;
                },
                failAndReload
              );
            }, 0);
            break;
          }
          omcReconnecting = false;
          location.reload();
        }
      }
      break;
    }`,
  );

  return { code: next, patched: true };
}

function normalizeFsPath(filePath) {
  return path.resolve(filePath).replaceAll('\\', '/');
}

function isIgnoredWatchPath(filePath, rootDir) {
  if (typeof filePath !== 'string' || !filePath) return true;
  const normalized = normalizeFsPath(filePath);
  const normalizedRoot = normalizeFsPath(rootDir).replace(/\/+$/, '');
  if (!normalized.startsWith(`${normalizedRoot}/`)) return true;
  const relative = normalized.slice(normalizedRoot.length + 1);
  return (
    relative.startsWith('node_modules/') ||
    relative.startsWith('dist/') ||
    relative.startsWith('.git/') ||
    relative.startsWith('.vite/')
  );
}

/**
 * Dev-only Vite plugin that prevents mobile background-to-foreground WebSocket
 * drops from forcing full-page reloads while keeping desktop HMR and real
 * server-restart / file-change reloads intact.
 */
export function devHmrResiliencePlugin() {
  const instanceId = crypto.randomUUID();
  let revision = 0;
  let rootDir = '';

  return {
    name: 'omc-dev-hmr-resilience',
    apply: 'serve',
    configResolved(config) {
      rootDir = config.root;
    },
    configureServer(server) {
      const strippedStatePath = `/${DEV_HMR_STATE_SUFFIX}`;
      const onFsChange = (changedFile) => {
        if (isIgnoredWatchPath(changedFile, rootDir)) return;
        revision += 1;
      };
      server.watcher.on('change', onFsChange);
      server.watcher.on('add', onFsChange);
      server.watcher.on('unlink', onFsChange);

      // Count Vite-initiated `full-reload` messages (such as dependency re-optimization) so
      // a disconnected tab does not reconnect against a stale module graph.
      const hotChannel = server.environments?.client?.hot ?? server.ws;
      if (hotChannel && typeof hotChannel.send === 'function') {
        const originalSend = hotChannel.send.bind(hotChannel);
        hotChannel.send = (...args) => {
          const payload = args.length > 0 && typeof args[0] === 'object' ? args[0] : null;
          if (payload?.type === 'full-reload') {
            revision += 1;
          }
          return originalSend(...args);
        };
      }

      // Register in the post hook so Vite's host check and base-path stripping run first.
      return () => {
        server.middlewares.use((request, response, next) => {
          const pathname = (request.url || '').split('?')[0];
          if (pathname !== strippedStatePath) return next();
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify({ instanceId, revision }));
        });
      };
    },
    hotUpdate(ctx) {
      // Also bump revision for watched modules outside `rootDir` (including deletions, which
      // Vite 6 passes to `hotUpdate` with type 'delete' rather than `handleHotUpdate`).
      if (ctx?.environment?.name && ctx.environment.name !== 'client') return;
      revision += 1;
    },
    transformIndexHtml(html) {
      const snapshot = JSON.stringify({ instanceId, revision });
      const script = `<script>window.${DEV_HMR_BOOT_GLOBAL} = ${snapshot};</script>`;
      if (html.includes('</head>')) {
        return html.replace('</head>', `  ${script}\n  </head>`);
      }
      return `${script}${html}`;
    },
    transform(code, id) {
      const normalizedId = id.replaceAll('\\', '/').split('?')[0];
      if (!normalizedId.endsWith('/vite/dist/client/client.mjs')) return null;
      const result = patchViteClientForBackgroundResume(code);
      return result.patched ? { code: result.code, map: null } : null;
    },
  };
}

export function resolveBareBaseRedirect(base, requestUrl) {
  const mountPath = base.replace(/\/+$/, '');
  if (!mountPath.startsWith('/') || typeof requestUrl !== 'string') return null;
  const queryStart = requestUrl.indexOf('?');
  const pathname = queryStart < 0 ? requestUrl : requestUrl.slice(0, queryStart);
  if (pathname !== mountPath) return null;
  return `${mountPath}/${queryStart < 0 ? '' : requestUrl.slice(queryStart)}`;
}

export function bareBaseRedirectPlugin() {
  let base = '/';
  return {
    name: 'bare-base-redirect',
    apply: 'serve',
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      // Registered directly rather than from a returned hook, so it runs ahead
      // of Vite's own base middleware, which is what answers 404 here.
      server.middlewares.use((request, response, next) => {
        const location = resolveBareBaseRedirect(base, request.url);
        if (!location) return next();
        // Temporary on purpose: a browser caches a 308 indefinitely, and a dev
        // origin is shared by whatever else later runs on the same port.
        response.writeHead(302, { Location: location });
        response.end();
      });
    },
  };
}

/** Injects the same runtime paths the Go server would provide in a built deployment. */
export function devRuntimeConfigPlugin(base) {
  const normalizedBase = base === '/' ? '' : base.replace(/\/+$/, '');
  const config = {
    basePath: normalizedBase,
    apiBaseUrl: `${normalizedBase}/api/v1`,
    mediaBaseUrl: `${normalizedBase}/media`,
    appName: 'Oh My CPA',
  };
  const configured = JSON.stringify(config);
  // Preserve fields a harness or test prime set before the document loads. The
  // generated bases still win over the inert defaults in index.html.
  const script = `<script>window.__OMCPA_CONFIG__ = Object.assign({}, window.__OMCPA_CONFIG__ || {}, ${configured});</script>`;
  return {
    name: 'dev-runtime-config',
    apply: 'serve',
    transformIndexHtml(html) {
      if (!html.includes('__OMCPA_CONFIG__')) return html;
      return html.replace(/<script>[\s\S]*?__OMCPA_CONFIG__[\s\S]*?<\/script>/, script);
    },
  };
}
