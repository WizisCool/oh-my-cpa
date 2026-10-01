import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChartMountQueue } from '../web/src/utils/chartMountQueue.ts';

function createFixture() {
  const tasks = new Set<() => void>();
  const enqueue = createChartMountQueue((task) => {
    tasks.add(task);
    return () => { tasks.delete(task); };
  });
  function advanceTask() {
    assert.equal(tasks.size, 1, 'only one frame/task may be pending');
    const task = tasks.values().next().value!;
    tasks.delete(task);
    task();
  }
  return { tasks, enqueue, advanceTask };
}

test('chart mounts are FIFO, never eager and only one runs per scheduled task', () => {
  const fixture = createFixture();
  const mounted: number[] = [];
  for (let i = 0; i < 8; i++) fixture.enqueue(() => { mounted.push(i); });
  assert.deepEqual(mounted, []);
  for (let i = 0; i < 8; i++) {
    fixture.advanceTask();
    assert.deepEqual(mounted, Array.from({ length: i + 1 }, (_, index) => index));
  }
  assert.equal(fixture.tasks.size, 0);
});

test('unmount cancels queued jobs and an empty queue cancels the browser callback', () => {
  const fixture = createFixture();
  const mounted: string[] = [];
  const cancelFirst = fixture.enqueue(() => { mounted.push('first'); });
  const cancelSecond = fixture.enqueue(() => { mounted.push('second'); });
  const cancelThird = fixture.enqueue(() => { mounted.push('third'); });
  cancelSecond();
  fixture.advanceTask();
  assert.deepEqual(mounted, ['first']);
  cancelFirst();
  cancelThird();
  cancelThird();
  assert.equal(fixture.tasks.size, 0);
  assert.deepEqual(mounted, ['first']);
});

test('StrictMode cleanup followed by setup mounts only the live job', () => {
  const fixture = createFixture();
  let mounts = 0;
  const cancel = fixture.enqueue(() => { mounts++; });
  cancel();
  fixture.enqueue(() => { mounts++; });
  fixture.advanceTask();
  assert.equal(mounts, 1);
  assert.equal(fixture.tasks.size, 0);
});

test('a mount may enqueue/cancel other jobs without combining their tasks', () => {
  const fixture = createFixture();
  const mounted: string[] = [];
  let cancelSecond = () => {};
  fixture.enqueue(() => {
    mounted.push('first');
    cancelSecond();
    fixture.enqueue(() => { mounted.push('third'); });
  });
  cancelSecond = fixture.enqueue(() => { mounted.push('second'); });
  fixture.advanceTask();
  assert.deepEqual(mounted, ['first']);
  fixture.advanceTask();
  assert.deepEqual(mounted, ['first', 'third']);
  assert.equal(fixture.tasks.size, 0);
});

test('one failed mount does not strand later jobs', () => {
  const fixture = createFixture();
  let mounts = 0;
  fixture.enqueue(() => { throw new Error('mount failed'); });
  fixture.enqueue(() => { mounts++; });
  assert.throws(fixture.advanceTask, /mount failed/);
  fixture.advanceTask();
  assert.equal(mounts, 1);
  assert.equal(fixture.tasks.size, 0);
});
