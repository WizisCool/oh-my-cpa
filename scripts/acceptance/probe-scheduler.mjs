/**
 * A bounded queue; each task owns its context and verdict, never a shared page.
 *
 * A scenario marked `shouldRunAlone` is run after the shared queue, with no sibling (ADR 0095).
 * Those scenarios assert what happens frame by frame - a glide that must move on every shown
 * frame, a flick that must still be coasting when it is tapped - and a sibling context rendering
 * on the same CPU drops frames the product does not drop, which read as the defect itself.
 */
export async function runScenarioQueue(scenarios, runScenario, { concurrency = 1, shouldStop = () => false } = {}) {
  if (concurrency !== 1 && concurrency !== 2) throw new Error('Probe concurrency must be one or two');
  const isAlone = scenario => Boolean(scenario?.shouldRunAlone);
  const runBounded = async (queue, workers) => {
    let nextScenarioIndex = 0;
    const runWorker = async () => {
      while (!shouldStop() && nextScenarioIndex < queue.length) {
        const scenario = queue[nextScenarioIndex++];
        await runScenario(scenario);
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(workers, queue.length) }, runWorker));
    return outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
  };
  const errors = [
    ...await runBounded(scenarios.filter(scenario => !isAlone(scenario)), concurrency),
    ...await runBounded(scenarios.filter(isAlone), 1),
  ];
  if (errors.length) throw new AggregateError(errors, 'Probe scenario worker failed');
}
