// Sends the dev server's bare mount path to its canonical slash.
//
// Vite only serves URLs under its `base`, which ends in a slash, so /omc gets a
// 404 hint page there while the Go server redirects the same address
// (internal/api Router). Development follows the server so a hand-typed or
// bookmarked /omc opens the console in both.

// Returns the redirect target for a request URL, or null when the request is
// not for the bare mount path. The query string survives the redirect. A root
// or relative base (the production build's './') has no mount path to redirect.
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
