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
