import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

// Hold the instant across a UTC/local date boundary so host timezone leakage is observable.
for (const timezone of ['UTC', 'Asia/Kuala_Lumpur', 'America/Los_Angeles']) {
  test(`heatmap fixtures use the console's UTC calendar on ${timezone} hosts`, () => {
    const script = `
      const NativeDate = Date;
      const instant = NativeDate.parse('2026-09-29T16:10:00Z');
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [instant])); }
        static now() { return instant; }
      };
      const { chartTokenHeatmap, heatmapMarked, HEATMAP_TODAY } =
        await import('./scripts/acceptance/probes/dashboardFixtures.mjs');
      console.log(JSON.stringify({ fixture: chartTokenHeatmap, marked: heatmapMarked, today: HEATMAP_TODAY }));
    `;
    const { fixture, marked, today } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, TZ: timezone },
      encoding: 'utf8',
    }));
    assert.equal(fixture.timezone, 'UTC');
    assert.equal(today, '2026-09-29');
    assert.equal(marked[0].day, today);
    for (const day of fixture.days) {
      if (day.day > today) {
        assert.equal(day.from_ms, 0);
        assert.equal(day.tokens, 0);
      } else {
        assert.equal(new Date(day.from_ms).toISOString().slice(0, 10), day.day);
        assert.equal(new Date(day.from_ms).getUTCHours(), 0);
      }
    }
    assert.equal(fixture.days.filter(day => day.tokens > 0).length, marked.filter(day => day.tokens > 0).length);
  });
}

// The scenario serves the day grid built when this module loads and a check recomputes the span it
// expects minutes later, so the two have to be the same grid. Reading the clock per call made them
// disagree by a day whenever the process crossed UTC midnight in between - a comparison that has
// nothing to do with time failed on a run that straddled midnight. The base day is frozen instead.
test('the day grid does not shift when the process crosses UTC midnight', () => {
  const script = `
    const NativeDate = Date;
    let now = NativeDate.parse('2026-09-29T23:58:00Z');
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    const { chartTokenHeatmap, heatmapGridDays, HEATMAP_TODAY } =
      await import('./scripts/acceptance/probes/dashboardFixtures.mjs');
    const served = chartTokenHeatmap.days;
    now = NativeDate.parse('2026-09-30T00:02:00Z');
    const recomputed = heatmapGridDays();
    console.log(JSON.stringify({
      today: HEATMAP_TODAY,
      served: { first: served[0].day, last: served[served.length - 1].day, length: served.length },
      recomputed: { first: recomputed[0].day, last: recomputed[recomputed.length - 1].day, length: recomputed.length },
      identical: JSON.stringify(served) === JSON.stringify(recomputed),
    }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  }));
  assert.equal(result.today, '2026-09-29', 'the fixture day is the day this module loaded on');
  assert.equal(result.served.length, 371, 'the grid is a year of whole weeks');
  assert.equal(result.recomputed.length, result.served.length, 'a later recomputation spans the same number of days');
  assert.equal(result.recomputed.first, result.served.first, 'a later recomputation starts on the same day');
  assert.equal(result.recomputed.last, result.served.last, 'a later recomputation ends on the same day');
  assert.ok(result.identical, 'the span a check recomputes is the span the scenario served');
});
