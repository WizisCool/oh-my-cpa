(function(){var P="__OMC_PLUGIN_HOST_PREFIX__";
  const nativePaths = /^(?:\/v0\/resource\/plugins\/|\/v[08]\/management\/|\/v1\/models$)/;
  function hostURL(input) {
    try {
      const url = new URL(input, location.href);
      if (url.origin !== location.origin) return null;
      const path = url.pathname.startsWith(P + '/') ? url.pathname.slice(P.length) : url.pathname;
      if (!nativePaths.test(path)) return null;
      url.pathname = P + path;
      return url.href;
    } catch {
      return null;
    }
  }

  // An equal-width property alias keeps adapted scripts' source-map coordinates
  // intact while leaving the browser's real pathname inside the console mount.
  Object.defineProperty(location, '_omcPath', {
    get() {
      return location.pathname.startsWith(P + '/') ? location.pathname.slice(P.length) : location.pathname;
    },
    set(value) {
      const url = new URL(location.href);
      url.pathname = value;
      location.pathname = new URL(hostURL(url.href) || url.href).pathname;
    },
  });

  // Pages also feed pathname back into history when removing a query-string key.
  // Keep those same-document URLs inside the host so reloads still reach OMC.
  const history = window.history;
  if (history) for (const method of ['pushState', 'replaceState']) {
    const changeState = history[method];
    history[method] = function() {
      if (arguments.length > 2 && arguments[2] != null) arguments[2] = hostURL(String(arguments[2])) || arguments[2];
      return changeState.apply(this, arguments);
    };
  }

  const nativeFetch = window.fetch;
  if (nativeFetch) window.fetch = function(input, init) {
    const target = hostURL(typeof input === 'string' || input instanceof URL ? String(input) : input && input.url);
    if (!target) return nativeFetch.call(this, input, init);
    if (input && input.url) {
      const request = new Request(input, init);
      const options = {};
      for (const key of ['method', 'headers', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'signal']) options[key] = request[key];
      options.credentials = 'same-origin';
      // HTTP/1 cannot upload a Request's ReadableStream, even for an original JSON body.
      if (request.body) return request.arrayBuffer().then(body => nativeFetch.call(this, target, {...options, body}));
      return nativeFetch.call(this, target, options);
    }
    return nativeFetch.call(this, target, {...init, credentials: 'same-origin'});
  };

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    XHR.prototype.open = function() {
      if (arguments.length > 1) arguments[1] = hostURL(String(arguments[1])) || arguments[1];
      return open.apply(this, arguments);
    };
  }
  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    window.EventSource = function(url, options) { return new NativeEventSource(hostURL(String(url)) || url, options); };
    window.EventSource.prototype = NativeEventSource.prototype;
  }
})();
