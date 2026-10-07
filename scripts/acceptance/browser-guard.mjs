const GUARDS = new WeakMap();
const matches = (pattern, text) => {
  pattern.lastIndex = 0;
  const hasMatched = pattern.test(text);
  pattern.lastIndex = 0;
  return hasMatched;
};

export function createProblemLedger() {
  const problems = [];
  const expectations = [];
  return {
    problems,
    expect(rule) {
      if (!rule.kind || (!rule.url && !rule.message) || !Number.isSafeInteger(rule.count) || rule.count < 1) {
        throw new Error('Expected browser problems require kind, exact URL/message matcher and bounded count');
      }
      expectations.push({ ...rule, remaining: rule.count });
    },
    record(problem) { problems.push(problem); },
    unexpected() {
      const rules = expectations.map(rule => ({...rule}));
      return problems.filter(problem => {
        const matched = rules.find(rule => rule.remaining > 0 && rule.kind === problem.kind
          && (!rule.url || matches(rule.url, problem.url ?? ''))
          && (!rule.message || matches(rule.message, problem.message ?? ''))
          && (!rule.method || rule.method === problem.method)
          && (!rule.status || rule.status === problem.status));
        if (matched) { matched.remaining -= 1; return false; }
        return true;
      });
    },
  };
}

const exact = text => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** Applied before scenario routes: the later fixture handlers must fallback, never continue. */
export async function guardBrowserContext(context, origins, { ledger = createProblemLedger() } = {}) {
  const allowed = new Set(origins.map(origin => new URL(origin).origin));
  GUARDS.set(context, ledger);
  const recordedRequests = new WeakSet();
  const inspectRequest = request => {
    if (allowed.has(new URL(request.url()).origin) || recordedRequests.has(request)) return;
    recordedRequests.add(request);
    ledger.record({ kind: 'outbound', url: request.url(), method: request.method(), message: 'Undeclared network origin' });
  };
  // Observe before routing: a later synthetic fulfill must not hide outbound intent.
  context.on('request', inspectRequest);
  const inspectPage = page => {
    page.on('pageerror', error => ledger.record({ kind: 'pageerror', message: error.message }));
    page.on('console', message => {
      if (message.type() === 'error') ledger.record({ kind: 'console', message: message.text(), url: message.location().url });
    });
    page.on('requestfailed', request => {
      const message = request.failure()?.errorText ?? '';
      // Cancellation belongs to navigation/AbortController, not an unavailable endpoint.
      if (message === 'net::ERR_ABORTED') return;
      ledger.record({kind:'requestfailed',url:request.url(),method:request.method(),message});
    });
  };
  context.on('page', inspectPage);
  for (const page of context.pages()) inspectPage(page);
  await context.route('**/*', async route => {
    const request = route.request();
    if (allowed.has(new URL(request.url()).origin)) return route.fallback();
    inspectRequest(request);
    return route.abort('blockedbyclient');
  });
  // Vite's HMR socket is local. A WebSocket never passes HTTP route interception.
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    if (allowed.has(url.origin)) socket.connectToServer();
    else {
      ledger.record({kind:'outbound',url:socket.url(),message:'Undeclared WebSocket origin'});
      socket.close();
    }
  });
  return ledger;
}

export async function fulfillFixture(route, response) {
  if (response.status >= 400) {
    const request = route.request();
    const ledger = GUARDS.get(request.frame().page().context());
    // Chromium attributes failed-resource console messages to the response URL.
    ledger?.expect({kind:'console',url:exact(request.url()),message:new RegExp(`^Failed to load resource: the server responded with a status of ${response.status}\\b`),count:1});
  }
  return route.fulfill(response);
}

export async function abortFixture(route, reason = 'failed') {
  const request = route.request();
  const ledger = GUARDS.get(request.frame().page().context());
  ledger?.expect({kind:'requestfailed',url:exact(request.url()),method:request.method(),count:1});
  ledger?.expect({kind:'console',url:exact(request.url()),message:/^Failed to load resource:/,count:1});
  return route.abort(reason);
}
