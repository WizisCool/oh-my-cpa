import { strict as assert } from 'node:assert';
import { renderChartTooltip } from '../web/src/charts/chartTooltip';
import { buildModelTrendData } from '../web/src/charts/modelTrendData';
import type { DashboardModelUsage } from '../web/src/types/dashboardModels';

const tooltip = renderChartTooltip('<time>', [{ name: '<img onerror="run()">', color: '#abcdef', value: '1K tokens', exact: '1,024 tokens' }]);
assert.ok(tooltip.includes('&lt;time&gt;'));
assert.ok(tooltip.includes('&lt;img onerror=&quot;run()&quot;&gt;'));
assert.ok(!tooltip.includes('<img'));
assert.ok(tooltip.includes('title="1,024 tokens"'));
assert.ok(tooltip.includes('1K tokens'));
assert.ok(renderChartTooltip('time', [{ value: '<value>' }]).includes('&lt;value&gt;'));

const metricTooltip = renderChartTooltip('10-06 12:34', [{ color: '#abcdef', value: '42', exact: '42 requests' }]);
assert.ok(metricTooltip.includes('<div class="omc-tip-rows">'));
assert.ok(!metricTooltip.includes('omc-tip-name'), 'a metric does not reserve a name column');
assert.ok(!metricTooltip.includes('omc-tip-share'), 'a metric does not reserve a share column');
assert.ok(metricTooltip.includes('aria-hidden="true"'), 'the color marker is decorative');
assert.ok(tooltip.includes('class="omc-tip-rows has-names"'));
assert.ok(tooltip.includes('class="omc-tip-name" title="&lt;img onerror=&quot;run()&quot;&gt;"'), 'truncated labels retain the full escaped name');
const ringTooltip = renderChartTooltip(undefined, [{ name: '<model>', color: '#abcdef', value: '1万 词元', exact: '10,024 词元', share: '<0.1%' }]);
assert.ok(!ringTooltip.includes('omc-tip-time'), 'a donut has no timestamp heading');
assert.ok(ringTooltip.includes('class="omc-tip-rows has-names has-shares"'));
assert.ok(ringTooltip.includes('class="omc-tip-share">&lt;0.1%</span>'));
assert.ok(ringTooltip.includes('title="10,024 词元"'));
assert.ok(ringTooltip.includes('1万 词元'), 'localized units pass through unchanged');
const mixedTooltip = renderChartTooltip('time', [{ name: 'first', value: '1' }, { value: '2' }]);
assert.equal(mixedTooltip.match(/class="omc-tip-row"/g)?.length, 2);
assert.ok(mixedTooltip.includes('class="omc-tip-rows has-names"'), 'rows share one name/value alignment');

const group: DashboardModelUsage = { model: 'first', folded: false, tokens: 12, requests: 2, cost_usd: 0,
  series: [0, 5, 0, 0, 0, 7, 0].map((tokens, index) => ({ t: index * 60000, tokens })) };
const data = buildModelTrendData([group, { ...group, model: 'second' }]);
assert.deepEqual(data.slice(7).map((point) => point.tokens), [0, 5, 0, 0, 0, 7, 0]);
assert.equal(data[0].series, 'model:second');
assert.equal(data.at(-1)?.series, 'model:first');
assert.deepEqual(data.slice(7).map((point) => point.bucket), group.series.map((point) => String(point.t)));
assert.deepEqual(buildModelTrendData([]), []);
console.log('chart tooltip and continuous zero-bucket trend assertions passed');
