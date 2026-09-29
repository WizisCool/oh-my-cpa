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

const group: DashboardModelUsage = { model: 'first', folded: false, tokens: 12, requests: 2, cost_usd: 0,
  series: [0, 5, 0, 0, 0, 7, 0].map((tokens, index) => ({ t: index * 60000, tokens })) };
const data = buildModelTrendData([group, { ...group, model: 'second' }]);
assert.deepEqual(data.slice(7).map((point) => point.tokens), [0, 5, 0, 0, 0, 7, 0]);
assert.equal(data[0].series, 'model:second');
assert.equal(data.at(-1)?.series, 'model:first');
assert.deepEqual(data.slice(7).map((point) => point.bucket), group.series.map((point) => String(point.t)));
assert.deepEqual(buildModelTrendData([]), []);
console.log('chart tooltip and continuous zero-bucket trend assertions passed');
