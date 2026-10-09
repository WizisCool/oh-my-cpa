/** A bounded queue; each task owns its context and verdict, never a shared page. */
export async function runScenarioQueue(scenarios, runScenario, { concurrency = 1, shouldStop = () => false } = {}) {
  if (concurrency !== 1 && concurrency !== 2) throw new Error('Probe concurrency must be one or two');
  let nextScenarioIndex = 0;
  const runWorker = async () => {
    while (!shouldStop() && nextScenarioIndex < scenarios.length) {
      const scenario = scenarios[nextScenarioIndex++];
      await runScenario(scenario);
    }
  };
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, scenarios.length) }, runWorker));
  const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
  if (errors.length) throw new AggregateError(errors, 'Probe scenario worker failed');
}
