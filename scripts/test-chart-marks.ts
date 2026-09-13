import assert from 'node:assert/strict';
import { buildSparkGeometry, sparkDomain } from '../web/src/charts/chartTheme.ts';

const domain = sparkDomain([0, 40, 80, 0]) ?? { domainMin: 0, domainMax: 100 };
const geometry = buildSparkGeometry([0, 40, 80, 0], domain, 44);

assert.match(geometry.linePath, /^M /, 'the trend starts with a move command');
assert.match(geometry.linePath, / C /, 'the trend uses a smooth curve');
assert.ok(!geometry.linePath.endsWith('Z'), 'the stroked trend path must stay open');
assert.ok(geometry.areaPath.endsWith('Z'), 'the fill-only area path closes at the baseline');
assert.ok(geometry.areaPath.startsWith(geometry.linePath), 'the area reuses the trend geometry');

const flat = sparkDomain([5, 5, 5]);
assert.ok(flat && flat.domainMax > 5, 'a flat series keeps headroom');
assert.equal(flat?.domainMin, 0, 'a flat series sits above zero, not on it');
const withZero = sparkDomain([0, 10, 20]);
assert.equal(withZero?.domainMin, 0, 'a series containing zero keeps zero as its floor');
assert.equal(sparkDomain([]), undefined, 'an empty series has no domain');

console.log('PASS chart marks: fill-only area, separate open trend path');
