import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceDrawnProgress,
  estimateProgress,
  isProgressBatchComplete,
  PENDING_CREDIT_CAP,
  PROGRESS_FLOOR,
  PROGRESS_SHOW_DELAY_MS,
  reconcileProgressBatch,
  shouldShowProgress,
  type ProgressBatch,
} from '../web/src/utils/loadProgress.ts';
import { beginProgressTask, mergeProgressSources, progressTasks, type ProgressSource } from '../web/src/utils/progressTasks.ts';

const ids = (...values: string[]) => new Set(values);

/** Feeds a sequence of in-flight snapshots through the reconciler, as the bar's source would. */
function replay(steps: Array<[number, Set<string>]>): ProgressBatch | null {
  let batch: ProgressBatch | null = null;
  for (const [now, inFlight] of steps) batch = reconcileProgressBatch(batch, inFlight, now);
  return batch;
}

test('no work in flight is no batch, and the first task opens one at its start time', () => {
  assert.equal(reconcileProgressBatch(null, ids(), 0), null);
  const batch = reconcileProgressBatch(null, ids('a'), 40)!;
  assert.equal(batch.startedAt, 40);
  assert.equal(batch.started, 1);
  assert.equal(batch.settled, 0);
});

test('each settled task counts in full and the bar reports the measured share', () => {
  const batch = replay([[0, ids('a', 'b', 'c', 'd')], [100, ids('c', 'd')]])!;
  assert.equal(batch.started, 4);
  assert.equal(batch.settled, 2);
  // Without estimation only settled work counts: exactly half.
  assert.equal(estimateProgress(batch, 100, false), 0.5);
});

test('a pending task earns credit that approaches its cap and never fills the bar', () => {
  const batch = replay([[0, ids('slow')]])!;
  const early = estimateProgress(batch, 100);
  const later = estimateProgress(batch, 3000);
  const forever = estimateProgress(batch, 10 * 60 * 1000);
  assert.ok(early < later, `credit grows with time (${early} -> ${later})`);
  assert.ok(forever <= PENDING_CREDIT_CAP + 1e-9, `a pending task stays at or under its cap (${forever})`);
  assert.ok(forever < 1);
  assert.equal(estimateProgress(batch, 0), PROGRESS_FLOOR, 'the first frame is the visible floor');
});

test('a task joining late raises the denominator and starts its own credit at zero', () => {
  const batch = replay([[0, ids('a')], [1000, ids('a', 'b')]])!;
  assert.equal(batch.started, 2);
  assert.equal(batch.pending.get('a'), 0);
  assert.equal(batch.pending.get('b'), 1000);
});

test('a task that settles and starts again is counted as a second piece of work', () => {
  const batch = replay([[0, ids('a', 'b')], [50, ids('b')], [60, ids('a', 'b')]])!;
  assert.equal(batch.started, 3);
  assert.equal(batch.settled, 1);
});

test('the last task settling completes the batch at 1, and new work afterwards opens a fresh batch', () => {
  const done = replay([[0, ids('a', 'b')], [300, ids()]])!;
  assert.ok(isProgressBatchComplete(done));
  assert.equal(estimateProgress(done, 300), 1);
  // Idle snapshots leave the completed batch as it is for the caller to retire.
  assert.equal(reconcileProgressBatch(done, ids(), 400), done);
  const next = reconcileProgressBatch(done, ids('c'), 500)!;
  assert.equal(next.startedAt, 500);
  assert.equal(next.started, 1);
  assert.equal(next.settled, 0);
});

test('a batch paints only after the show delay, so a fast read never flashes the bar', () => {
  const batch = replay([[1000, ids('a')]])!;
  assert.equal(shouldShowProgress(batch, 1000 + PROGRESS_SHOW_DELAY_MS - 1), false);
  assert.equal(shouldShowProgress(batch, 1000 + PROGRESS_SHOW_DELAY_MS), true);
});

test('the drawn bar closes on the target independent of frame rate and never moves backwards', () => {
  const oneStep = advanceDrawnProgress(0.2, 0.6, 32);
  let twoSteps = advanceDrawnProgress(0.2, 0.6, 16);
  twoSteps = advanceDrawnProgress(twoSteps, 0.6, 16);
  assert.ok(Math.abs(oneStep - twoSteps) < 1e-9, `${oneStep} vs ${twoSteps}`);
  assert.equal(advanceDrawnProgress(0.7, 0.4, 16), 0.7, 'a lower target holds the bar where it is');
  let drawn = 0.5;
  for (let frame = 0; frame < 120 && drawn < 1; frame += 1) drawn = advanceDrawnProgress(drawn, 1, 16);
  assert.equal(drawn, 1, 'a completed batch reaches its end instead of approaching it forever');
});

test('progress tasks publish their start and settle once, and merged sources read as one union', () => {
  const seen: number[] = [];
  const unsubscribe = progressTasks.subscribe(() => seen.push(progressTasks.read().size));
  const settle = beginProgressTask();
  assert.equal(progressTasks.read().size, 1);
  settle();
  settle();
  assert.deepEqual(seen, [1, 0], 'settling twice publishes once');
  unsubscribe();

  let listeners = 0;
  const fixed = (values: string[]): ProgressSource => ({
    read: () => new Set(values),
    subscribe: () => { listeners += 1; return () => { listeners -= 1; }; },
  });
  const merged = mergeProgressSources(fixed(['query:a']), fixed(['task:1', 'query:a']));
  assert.deepEqual([...merged.read()].sort(), ['query:a', 'task:1']);
  const stop = merged.subscribe(() => {});
  assert.equal(listeners, 2);
  stop();
  assert.equal(listeners, 0);
});
