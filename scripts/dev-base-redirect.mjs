// Keeps the Vite development entry consistent with the configured console mount.
//
// Vite only serves documents under its `base`, which ends in a slash, so a bare
// configured prefix gets Vite's 404 hint while the Go server redirects the same
// address. Development follows the server so a hand-typed or bookmarked prefix opens
// the console in both. A root base has no bare path to redirect.

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
