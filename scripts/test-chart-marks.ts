import assert from 'node:assert/strict';
import { lineOptions, sparkOptions, sparkDomain } from '../web/src/charts/chartTheme.ts';

/**
 * Pins the mark split that keeps the stray baseline out from under a sparkline.
 *
 * TinyArea - which the dashboard's area tiles render - is a view whose only child
 * is an `area` mark, and an area mark's shape is a *closed* polygon: the top
 * curve, two side edges and the bottom edge. Styling that mark with a stroke
 * therefore paints a horizontal rule along the plot floor. These assertions hold
 * the fix in place: the area mark is fill-only, and the trend line is its own
 * `line` child. A revert to a stroked area would fail here.
 */
const area = sparkOptions('dark', 'accent');
const line = lineOptions('dark', 'accent');

assert.equal(area.style.stroke, undefined, 'the area mark must not be stroked');
assert.equal(area.style.lineWidth, 0, 'the area mark must not carry a stroke width');
assert.ok(typeof area.style.fill === 'string' && area.style.fill.length > 0, 'the area mark keeps its fill');
assert.ok(area.style.fillOpacity !== undefined, 'the area fill stays translucent');

const areaTrendLine = area.line as { style?: { stroke?: string; lineWidth?: number } } | undefined;
assert.ok(areaTrendLine, 'the area variant draws the trend as its own line mark');
assert.equal(typeof areaTrendLine?.style?.stroke, 'string', 'the trend line carries the stroke colour');
assert.equal(areaTrendLine?.style?.lineWidth, 1.5, 'the trend line keeps the hairline width');

// The line variant has no area to avoid, so it must not stack a second line mark
// on top of its own.
assert.equal((line as Record<string, unknown>).line, undefined, 'the line variant must not add a line child');
assert.equal(typeof line.style.stroke, 'string', 'the line variant strokes its own mark');

// Both variants keep the shared chrome, so the split did not drop anything.
for (const [name, options] of [
  ['area', area],
  ['line', line],
] as const) {
  assert.deepEqual(options.axis, { x: false, y: false }, `${name}: axes stay off`);
  assert.equal((options as Record<string, unknown>).legend, false, `${name}: legend stays off`);
  assert.equal((options as Record<string, unknown>).animate, false, `${name}: entrance animation stays off`);
  assert.equal((options as Record<string, unknown>).tooltip, false, `${name}: tooltip stays opt-in`);
  assert.equal((options as Record<string, unknown>).shapeField, 'smooth', `${name}: curve stays smooth`);
}

// A flat series must not fill the whole box, and a zero floor must be allowed so a
// bucket with no traffic sits on the baseline rather than being lifted off it.
const flat = sparkDomain([5, 5, 5]);
assert.ok(flat && flat.domainMax > 5, 'a flat series keeps headroom');
assert.equal(flat?.domainMin, 0, 'a flat series sits above zero, not on it');
const withZero = sparkDomain([0, 10, 20]);
assert.equal(withZero?.domainMin, 0, 'a series containing zero keeps zero as its floor');
assert.equal(sparkDomain([]), undefined, 'an empty series has no domain');

console.log('PASS chart marks: fill-only area, separate trend line, line variant unstacked');
