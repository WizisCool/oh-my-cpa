import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DATASET, REFERENCE_MS, responseNameFor } from './routes.mjs';
import { rebase } from './time.mjs';

/**
 * A request to the demonstration's own host, so the path and query are what is under
 * test rather than any particular deployment.
 */
function request(path) {
  return new Request(`https://demo.example${path}`);
}

describe('the dataset the demonstration is served from', () => {
  it('is present and non-trivial', () => {
    // A dataset that failed to generate would otherwise pass every test below by
    // having nothing to check.
    assert.ok(REFERENCE_MS > 0, 'the dataset has no reference instant');
    assert.ok(
      Object.keys(DATASET.responses).length > 50,
      'the dataset has too few responses to be the console’s surface',
    );
  });

  it('carries no operator identity, credential or deployment hostname', () => {
    // The demonstration is public, so this is the assertion that matters most. It
    // looks for the classes of value that would be a leak rather than one literal, so
    // a future fixture cannot reintroduce one under a different name.
    const body = JSON.stringify(DATASET);
    for (const forbidden of [
      'junze',
      'dongjunze',
      'gmail.com',
      'vercel.app',
      'vcp_',
      'sk-',
      'ghp_',
      'xoxb-',
    ]) {
      assert.equal(
        body.includes(forbidden),
        false,
        `the dataset contains ${forbidden}`,
      );
    }
  });

  it('answers every response with a success', () => {
    // An error captured at export time would be served to a visitor as data.
    for (const [name, response] of Object.entries(DATASET.responses)) {
      assert.equal(response.status, 200, `${name} was captured as ${response.status}`);
    }
  });
});

/**
 * Replaces every instant with a marker, leaving the rest of the response untouched.
 *
 * The complement of the Worker's own re-basing rules, and deliberately written separately
 * rather than imported: a helper that shared the implementation it is checking would agree
 * with it about a misread field, which is exactly the mistake the re-basing made once
 * already when it read `claude-haiku-4-5` as a date.
 */
function withoutInstants(value) {
  const INSTANT_BY_NAME = /(?:^|_)at_ms$/;
  const INSTANT_NAMED = new Set([
    't', 'to_ms', 'as_of_ms', 'timestamp_ms', 'latest_after', 'from', 'to', 'modified',
    'exported_at', 'time', 'last_capture_at', 'last_run_at',
  ]);
  const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

  if (Array.isArray(value)) return value.map(withoutInstants);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [name, item] of Object.entries(value)) {
      out[name] =
        INSTANT_BY_NAME.test(name) || INSTANT_NAMED.has(name) ? '<instant>' : withoutInstants(item);
    }
    return out;
  }
  if (typeof value === 'string' && RFC3339.test(value)) return '<instant>';
  return value;
}

/**
 * The request list the console renders, served the way the page reads it.
 *
 * Rows are compared against a detail opened from one of them, so both sides have to go
 * through the Worker's own re-base rather than through the dataset's raw values.
 */
async function listedEvents(worker, env) {
  const response = await worker.fetch(request('/api/v1/usage/events'), env);
  return (await response.json()).items;
}

describe('routing', () => {
  it('serves each dashboard preset from its own captured window', () => {
    // Not the same response relabelled: the picker's positions have to hold different
    // numbers, or the control would look broken.
    const names = ['15m', '1h', '6h', '24h', '7d', '30d', '90d'].map((preset) =>
      responseNameFor(request(`/api/v1/management/dashboard?preset=${preset}`)),
    );
    assert.equal(new Set(names).size, names.length, 'two presets resolve to one response');
    for (const name of names) {
      assert.ok(DATASET.responses[name], `${name} is not in the dataset`);
    }
  });

  it('defaults the dashboard to the console’s own default window', () => {
    assert.equal(
      responseNameFor(request('/api/v1/management/dashboard')),
      'dashboard-24h',
    );
  });

  it('serves both model groupings', () => {
    const byCall = responseNameFor(
      request('/api/v1/management/dashboard/models?preset=24h&group_by=call'),
    );
    const byModel = responseNameFor(
      request('/api/v1/management/dashboard/models?preset=24h&group_by=model'),
    );
    assert.notEqual(byCall, byModel, 'the two groupings resolve to one response');
    assert.ok(DATASET.responses[byCall]);
    assert.ok(DATASET.responses[byModel]);
  });

  it('answers the heatmap for a viewer in any timezone', () => {
    // The console sends the viewer's IANA zone, which cannot be enumerated, so the
    // route has to answer every one of them rather than only the captured two.
    for (const zone of ['UTC', 'Asia/Kuala_Lumpur', 'America/New_York', 'Pacific/Chatham']) {
      const name = responseNameFor(
        request(`/api/v1/management/dashboard/token-heatmap?tz=${encodeURIComponent(zone)}`),
      );
      assert.ok(DATASET.responses[name], `${zone} resolved to a missing response`);
    }
  });

  it('answers a request record for whichever record the console opened', async () => {
    // Keyed to the captured id alone, every other row in the list answered "the
    // demonstration does not answer /api/v1/usage/events/…" - an English sentence about
    // a route, shown to a visitor who had just clicked a request.
    const { default: worker } = await import('./worker.mjs');
    const env = { ASSETS: { fetch: () => new Response('', { status: 200 }) } };
    const rows = JSON.parse(DATASET.responses['usage-events'].body).items;
    assert.ok(rows.length > 1, 'the list capture has to hold more than one record');
    for (const row of [rows[0], rows[rows.length - 1]]) {
      const response = await worker.fetch(request(`/api/v1/usage/events/${row.id}`), env);
      assert.equal(response.status, 200, `id ${row.id} was not answered`);
      const event = (await response.json()).event;
      // The drawer renders these, so a detail that named a different record than the row
      // that was clicked is the demonstration contradicting its own list on one screen.
      assert.equal(event.id, row.id);
      assert.equal(event.request_id, row.request_id);
      assert.equal(event.model, row.model);
      assert.equal(event.provider, row.provider);
      // The embedded timestamp is on the capture's calendar like every other instant, so the
      // identity has to be copied in before the re-base rather than after it: copied in
      // afterwards it stayed on the capture's date, months away from the row that was
      // clicked. The assertion is against the list the drawer was opened from, because that
      // is the surface the two have to agree with.
      const listed = (await listedEvents(worker, env)).find((item) => item.id === row.id);
      assert.ok(listed, `id ${row.id} is not in the served list`);
      const drift = Math.abs(event.timestamp_ms - listed.timestamp_ms);
      assert.ok(drift < 60_000, `id ${row.id}: detail and list are ${drift}ms apart`);
    }
  });

  it('answers a record the dataset does not hold without inventing one', async () => {
    // Turning it into the captured record's detail would describe a request the visitor
    // never clicked, which is worse than saying there is nothing here.
    const { default: worker } = await import('./worker.mjs');
    const env = { ASSETS: { fetch: () => new Response('', { status: 200 }) } };
    const rows = JSON.parse(DATASET.responses['usage-events'].body).items;
    const absent = Math.max(...rows.map((row) => row.id)) + 5000;
    const response = await worker.fetch(request(`/api/v1/usage/events/${absent}`), env);
    // The status is part of the answer: a 200 with an error body is read as a successful
    // detail that happens to be missing its event.
    assert.equal(response.status, 404);
    const served = await response.json();
    assert.equal(served.event, undefined, 'an unknown id was answered with a record');
    assert.equal(served.code, 'demo_record_unknown');
  });

  it('still refuses a request log, which quotes request content', async () => {
    const { default: worker } = await import('./worker.mjs');
    const env = { ASSETS: { fetch: () => new Response('', { status: 200 }) } };
    const rows = JSON.parse(DATASET.responses['usage-events'].body).items;
    const response = await worker.fetch(request(`/api/v1/usage/events/${rows[0].id}/request-log`), env);
    assert.equal(response.status, 403);
  });

  it('answers every fixed route the console reads', () => {
    const paths = [
      '/api/v1/management/overview',
      '/api/v1/management/system',
      '/api/v1/management/providers',
      '/api/v1/management/api-keys',
      '/api/v1/management/auth-files',
      '/api/v1/management/quota',
      '/api/v1/management/logs',
      '/api/v1/management/plugins',
      '/api/v1/management/plugin-store',
      '/api/v1/management/config',
      '/api/v1/pricing',
      '/api/v1/preferences',
      '/api/v1/resources',
      '/api/v1/usage/events',
      '/api/v1/usage/facets',
      '/api/v1/usage/ingest-status',
      '/api/v1/management/audit/events',
      '/api/v1/management/request-error-logs',
      // The session endpoint is under the auth root rather than under /api/v1, which is
      // the shape the console calls. It is listed here because getting it wrong puts
      // every page on the login card instead of the console.
      '/api/auth/session',
    ];
    for (const path of paths) {
      const name = responseNameFor(request(path));
      assert.ok(name, `${path} has no dataset entry`);
      assert.ok(DATASET.responses[name], `${path} resolved to a missing response`);
    }
  });

  it('reports the preset the console asked for', async () => {
    // The dataset holds closed windows, so a captured response echoes `custom`. The
    // console labels its range picker from this field, so serving the captured value
    // would leave the picker reading "custom" after a visitor chose "7 days".
    const { default: worker } = await import('./worker.mjs');
    const response = await worker.fetch(
      new Request('https://demo.example/api/v1/management/dashboard?preset=7d'),
      { ASSETS: { fetch: () => new Response('', { status: 200 }) } },
    );
    const payload = await response.json();
    assert.equal(payload.window.preset, '7d');
  });

  it('serves the health check from the dataset, not from a hand-written body', async () => {
    // This is the bug in the other direction from the session path. `/api/healthz` was
    // answered by a hardcoded response in the Worker, and that response omitted
    // `cpa_connected` - the field the console's header reads to decide whether it shows
    // the gateway as reachable. Every page then displayed "CPA offline" while the
    // overview reported it connected. The test asserts the served body equals the
    // captured one, which is what fails when a response is written by hand beside a
    // dataset that already has it.
    const { default: worker } = await import('./worker.mjs');
    const response = await worker.fetch(new Request('https://demo.example/api/healthz'), {
      ASSETS: { fetch: () => new Response('', { status: 200 }) },
    });
    const served = await response.json();
    const captured = JSON.parse(DATASET.responses.healthz.body);
    assert.deepEqual(served, captured);
    assert.equal(served.cpa_connected, true, 'the header reads this to report gateway reachability');
  });

  it('serves every fixed route from its dataset entry, changing only instants', async () => {
    // The general form of the test above: any response the Worker composes rather than
    // serving is one that can drift from what the console was built against, and the
    // health check proved that by drifting on the day it was written.
    //
    // Instants are compared separately rather than excluded, because re-basing them is
    // the Worker's job - a test that demanded byte equality would fail on every response
    // carrying a timestamp and would be measuring the clock, not the routing. What is
    // asserted is that nothing else differs: no field missing, none invented, no value
    // changed by the walk.
    const { default: worker } = await import('./worker.mjs');
    for (const path of [
      '/api/auth/session',
      '/api/v1/management/overview',
      '/api/v1/management/system',
      '/api/v1/preferences',
      '/api/v1/pricing',
      '/api/v1/usage/events',
    ]) {
      const response = await worker.fetch(new Request(`https://demo.example${path}`), {
        ASSETS: { fetch: () => new Response('', { status: 200 }) },
      });
      assert.equal(response.status, 200, `${path} did not answer`);
      const name = responseNameFor(request(path));
      assert.deepEqual(
        withoutInstants(await response.json()),
        withoutInstants(JSON.parse(DATASET.responses[name].body)),
        `${path} does not match its captured response`,
      );
    }
  });

  it('does not answer a path it has no data for', () => {
    // A route that fell through to a default would render a page with another page's
    // numbers, which is worse than an error the console can explain.
    assert.equal(responseNameFor(request('/api/v1/management/not-a-real-route')), undefined);
  });
});

describe('re-basing onto the viewer’s clock', () => {
  it('moves a millisecond instant by the delta', () => {
    const moved = rebase({ t: REFERENCE_MS }, 3_600_000);
    assert.equal(moved.t, REFERENCE_MS + 3_600_000);
  });

  it('moves a seconds instant by the delta in seconds', () => {
    // A seconds field is three orders of magnitude smaller, and shifting it by a
    // millisecond delta would move it millions of years.
    const seconds = Math.floor(REFERENCE_MS / 1000);
    const moved = rebase({ modified: seconds }, 3_600_000);
    assert.equal(moved.modified, seconds + 3600);
  });

  it('moves a window and its buckets together', () => {
    // The property the dashboard depends on: a bucket never falls outside the window
    // it is drawn in.
    const before = { from: REFERENCE_MS, to: REFERENCE_MS + 60_000, t: REFERENCE_MS };
    const after = rebase(before, 86_400_000);
    assert.equal(after.to - after.from, 60_000);
    assert.ok(after.t >= after.from && after.t <= after.to);
  });

  it('moves an instant written as text', () => {
    const moved = rebase({ observed: 'x', time: '2026-01-01T00:00:00Z' }, 1000);
    assert.equal(moved.time, '2026-01-01T00:00:01.000Z');
  });

  it('never rewrites a value that merely looks like a date to a lenient parser', () => {
    // This is a real bug that shipped in the first version of this module. `Date.parse`
    // reads `claude-haiku-4-5` as the 4th of May and `gpt-5` as a date in 2001, so a
    // rebase built on it turned the model catalogue into a list of models named after
    // dates. Model names are the values the console puts in front of a visitor, which
    // is what makes this worse than a display glitch.
    const models = {
      models: [
        { model: 'claude-haiku-4-5' },
        { model: 'gpt-5' },
        { model: 'gemini-2.5-flash' },
        { model: 'gpt-5.1-codex' },
      ],
    };
    assert.deepEqual(rebase(models, 86_400_000), models);
  });

  it('leaves values that are not instants alone', () => {
    // The failure this guards against is silent: a shifted token count or price is
    // still a plausible number.
    const untouched = {
      tokens: 1234,
      latency_ms: 812,
      cost_usd: 0.02983525,
      id: 13580,
      version: 1,
    };
    assert.deepEqual(rebase(untouched, 3_600_000), untouched);
  });

  it('walks nested structures and arrays', () => {
    const moved = rebase(
      { window: { from: REFERENCE_MS }, items: [{ timestamp_ms: REFERENCE_MS }] },
      1000,
    );
    assert.equal(moved.window.from, REFERENCE_MS + 1000);
    assert.equal(moved.items[0].timestamp_ms, REFERENCE_MS + 1000);
  });
});
