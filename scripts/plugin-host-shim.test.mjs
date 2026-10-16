import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../internal/api/management_plugin_host_shim.js', import.meta.url), 'utf8');

function host(prefix) {
  const requests = [];
  const location = new URL(`http://console.example${prefix}/v0/resource/plugins/example/panel?variant=a`);
  const window = {
    fetch: async (input, options) => {
      const request = new Request(input, options);
      requests.push(request);
      return new Response('{}');
    },
  };
  window.history = Object.fromEntries(['pushState', 'replaceState'].map(method => [method, function(_state, _title, url) {
    if (url != null) location.href = new URL(url, location.href).href;
  }]));
  const context = vm.createContext({ window, location, URL, Request });
  vm.runInContext(source.replace('"__OMC_PLUGIN_HOST_PREFIX__"', JSON.stringify(prefix)), context);
  return { window, location, requests };
}

for (const prefix of ['/api/v1/plugin-host', '/omc/api/v1/plugin-host', '/console/custom/api/v1/plugin-host']) {
  test(`hosted fetch sends the console session only to supported same-origin paths: ${prefix}`, async () => {
    const { window, requests } = host(prefix);
    for (const path of ['/v0/management/plugins/example/state', '/v8/management/config', '/v1/models?kind=a', '/v0/resource/plugins/example/login_status']) {
      for (const url of [`http://console.example${path}`, `http://console.example${prefix}${path}`]) {
        for (const kind of ['string', 'URL', 'Request']) {
          const options = { credentials: 'omit', headers: { Authorization: 'Bearer synthetic-page-key', 'X-Management-Key': 'synthetic-page-key' } };
          const input = kind === 'Request' ? new Request(url, options) : kind === 'URL' ? new URL(url) : url;
          await window.fetch(input, kind === 'Request' ? undefined : options);
          const request = requests.at(-1);
          assert.equal(request.credentials, 'same-origin', `${kind} ${url}`);
          assert.equal(request.url, `http://console.example${prefix}${path}`);
          assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-page-key');
          assert.equal(request.headers.get('X-Management-Key'), 'synthetic-page-key');
          assert.equal(options.credentials, 'omit');
        }
      }
    }
  });

  test(`unrelated fetch keeps its credential mode: ${prefix}`, async () => {
    const { window, requests } = host(prefix);
    for (const url of [
      `https://other.example${prefix}/v0/management/config`,
      'https://other.example/v0/management/config',
      'http://console.example/api/other',
      'http://console.example/v1/models-extra',
      `http://console.example${prefix}/v1/models/extra`,
      `http://console.example${prefix}-other/v0/management/config`,
      `http://console.example${prefix}/unrelated`,
    ]) {
      const input = new Request(url, { credentials: 'omit' });
      await window.fetch(input);
      assert.equal(requests.at(-1).url, url);
      assert.equal(requests.at(-1).credentials, 'omit');
    }
  });

  test(`Request bodies, overrides and cancellation survive hosting: ${prefix}`, async () => {
    const { window, requests } = host(prefix);
    const controller = new AbortController();
    const request = new Request('http://console.example/v0/management/plugins/example/sync', {
      method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer original-page-key' }, body: 'original',
    });
    await window.fetch(request, { credentials: 'omit', headers: { Authorization: 'Bearer overridden-page-key', 'Content-Type': 'application/json' }, body: '{"sync":true}', signal: controller.signal });
    const forwarded = requests.at(-1);
    assert.equal(forwarded.credentials, 'same-origin');
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.headers.get('Authorization'), 'Bearer overridden-page-key');
    assert.equal(forwarded.headers.get('Content-Type'), 'application/json');
    assert.equal(await forwarded.text(), '{"sync":true}');
    controller.abort();
    assert.equal(forwarded.signal.aborted, true);
  });

  test(`native history URLs stay inside the console mount: ${prefix}`, () => {
    const { window, location } = host(prefix);
    for (const method of ['pushState', 'replaceState']) {
      location.pathname = `${prefix}/v0/resource/plugins/example/panel`;
      window.history[method](null, '', location._omcPath + '?updated=1#panel');
      assert.equal(location.href, `http://console.example${prefix}/v0/resource/plugins/example/panel?updated=1#panel`);
      window.history[method](null, '', 'settings?updated=2');
      assert.equal(location.href, `http://console.example${prefix}/v0/resource/plugins/example/settings?updated=2`);
    }
  });

  test(`native resource pathname follows same-document navigation: ${prefix}`, () => {
    const { window, location } = host(prefix);
    assert.equal(location._omcPath, '/v0/resource/plugins/example/panel');
    assert.equal(location.pathname, `${prefix}/v0/resource/plugins/example/panel`);
    location.pathname = `${prefix}/v0/resource/plugins/other/settings`;
    assert.equal(location._omcPath, '/v0/resource/plugins/other/settings');
    location._omcPath = '/v0/resource/plugins/other/panel';
    assert.equal(location.pathname, `${prefix}/v0/resource/plugins/other/panel`);
    assert.equal(location.search, '?variant=a');
  });
}
