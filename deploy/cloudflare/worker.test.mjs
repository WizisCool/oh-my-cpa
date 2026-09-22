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
