import { test, prepareScenario } from '../../testing/probe-fixtures.ts';
import { SCENARIOS } from '../scenarios.mjs';

const ids = new Set<string>(JSON.parse(process.env.OMC_PROBE_IDS ?? '[]'));
const isExclusive = process.env.OMC_PROBE_PHASE === 'exclusive';
for (const scenario of SCENARIOS) {
  if (!ids.has(scenario.id) || Boolean(scenario.shouldRunAlone) !== isExclusive) continue;
  test.describe(scenario.id, () => {
    test.use({
      viewport: scenario.options?.viewport ?? { width: 1440, height: 1000 },
      hasTouch: scenario.options?.hasTouch ?? false,
    });
    test(scenario.name, { annotation: { type: 'scenario', description: scenario.id } }, async ({ probe }) => {
      await prepareScenario(probe, scenario.options?.routes);
      await scenario.run(probe);
    });
  });
}
