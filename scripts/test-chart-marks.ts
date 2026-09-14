import assert from 'node:assert/strict';
import { buildBarGeometry } from '../web/src/charts/chartTheme.ts';

// 1. Bar count matches bucket count
const buckets = [0, 40, 80, 0];
const geometry = buildBarGeometry(buckets, 44);
assert.equal(geometry.bars.length, buckets.length, 'bar count matches bucket count');

// 2. Bar lengths are monotonic in value
const monotonicValues = [0, 10, 25, 60, 100];
const monotonicGeo = buildBarGeometry(monotonicValues, 64);
for (let i = 0; i < monotonicGeo.bars.length - 1; i += 1) {
  assert.ok(
    monotonicGeo.bars[i].length <= monotonicGeo.bars[i + 1].length,
    `bar length must be monotonic: bar[${i}].length (${monotonicGeo.bars[i].length}) <= bar[${i + 1}].length (${monotonicGeo.bars[i + 1].length})`,
  );
}

// 3. Zero-value buckets are representable (have explicit flag and visible baseline mark)
const zeroBar = geometry.bars[0];
assert.ok(zeroBar.isZero, 'zero-value bucket is flagged as zero');
assert.ok(zeroBar.length > 0, 'zero-value bucket has a representable baseline length');
assert.ok(Number.isFinite(zeroBar.x) && Number.isFinite(zeroBar.y), 'zero-value bucket has valid coordinates');

// 4. Empty and single-bucket series do not throw
assert.doesNotThrow(() => {
  const emptyGeo = buildBarGeometry([], 44);
  assert.equal(emptyGeo.bars.length, 0, 'empty series produces 0 bars');
}, 'empty series does not throw');

assert.doesNotThrow(() => {
  const singleGeo = buildBarGeometry([42], 44);
  assert.equal(singleGeo.bars.length, 1, 'single-bucket series produces 1 bar');
  assert.equal(singleGeo.bars[0].value, 42);
}, 'single-bucket series does not throw');

console.log('PASS chart marks: bar count matches bucket count, monotonic bar lengths, zero-value representable');
