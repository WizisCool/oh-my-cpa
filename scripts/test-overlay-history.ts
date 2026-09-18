/**
 * Behavioural tests for the overlay history.
 *
 * These import `web/src/hooks/overlayHistory.ts` directly - the same module the React
 * binding wraps and every overlay uses - rather than restating its bookkeeping in the
 * test. A transcription can drift from the implementation and then pins nothing.
 *
 * The module takes its history operations as a host, so every case below is
 * deterministic: no browser, no React, and no sleeping. The two properties that cannot
 * be checked without a real engine - that `back()` closes the overlay and that the URL
 * survives it - are asserted in the browser suite instead, because a fake history can
 * only confirm that the module called `back()`.
 */
import assert from 'node:assert/strict';
import { createOverlayHistory, type OverlayHistoryHost } from '../web/src/hooks/overlayHistory.ts';

/**
 * A host that models the browser's entry list closely enough to check the arithmetic:
 * pushes append, `back()` moves the cursor, and `popstate` is delivered by the same call
 * that performs the traversal - which is what makes "did this module navigate?" a
 * question the test can answer.
 */
function createFakeHost(initialKey = 'k0') {
  const entries: { key: string | undefined; overlay?: string }[] = [{ key: initialKey }];
  let cursor = 0;
  let nextKey = 1;
  const scheduled: (() => void)[] = [];
  const pops: number[] = [];

  const host: OverlayHistoryHost = {
    currentKey: () => entries[cursor].key,
    pushSentinel: (id) => {
      entries.splice(cursor + 1);
      // A sentinel keeps the current entry's key, exactly as the browser host does when it
      // spreads the router's state.
      entries.push({ key: entries[cursor].key, overlay: id });
      cursor += 1;
    },
    goBack: () => {
      if (cursor === 0) return;
      cursor -= 1;
      pops.push(cursor);
    },
    schedule: (callback) => {
      scheduled.push(callback);
    },
  };

  return {
    host,
    /** A router navigation: pushes a fresh entry on top of whatever is current. */
    navigate: () => {
      entries.splice(cursor + 1);
      entries.push({ key: `k${nextKey++}` });
      cursor += 1;
    },
    /** The reader pressing Back: traverse, then deliver the pop to the listener. */
    pressBack: (history: ReturnType<typeof createOverlayHistory>) => {
      if (cursor === 0) return undefined;
      cursor -= 1;
      pops.push(cursor);
      return history.handlePop();
    },
    /** Runs the deferred departures, as a real microtask boundary would. */
    flushDeferred: () => {
      while (scheduled.length > 0) scheduled.shift()?.();
    },
    get cursor() {
      return cursor;
    },
    get length() {
      return entries.length;
    },
    get backCount() {
      return pops.length;
    },
  };
}

// ---- opening pushes one entry and Back dismisses the overlay ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.open('detail');
  assert.equal(browser.length, 2, 'opening pushes exactly one entry');
  assert.deepEqual(history.openStack, ['detail']);

  const dismissed = browser.pressBack(history);
  assert.equal(dismissed, 'detail', 'a platform Back names the overlay to dismiss');
  assert.deepEqual(history.openStack, [], 'and the sentinel is consumed');
  assert.equal(browser.backCount, 1);
}

// ---- closing from the overlay's own UI consumes its own sentinel ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.open('detail');
  history.close('detail');

  assert.equal(browser.backCount, 1, 'the overlay UI closing issues the traversal itself');
  assert.deepEqual(history.openStack, []);

  // The pop that answers it belongs to the sentinel, not to the reader: dismissing
  // whatever sits below would close an overlay nobody touched.
  assert.equal(history.handlePop(), undefined, 'the answering pop is not read as the reader');
}

// ---- the reverted-apply accident: a navigation after the sentinel ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.open('filters');
  browser.navigate();

  history.close('filters');

  assert.equal(
    browser.backCount,
    0,
    'with a router entry on top of the sentinel, back() would undo the navigation',
  );
  assert.deepEqual(history.openStack, [], 'the sentinel is still dropped from bookkeeping');
  assert.equal(browser.cursor, 2, 'and the reader stays on the entry the navigation produced');
}

// ---- nested overlays dismiss one at a time, top first ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.open('detail');
  history.open('download');

  assert.deepEqual(history.openStack, ['detail', 'download']);
  assert.equal(browser.pressBack(history), 'download', 'the top overlay goes first');
  assert.deepEqual(history.openStack, ['detail'], 'and the one below survives');
  assert.equal(browser.pressBack(history), 'detail');
  assert.deepEqual(history.openStack, []);
}

// ---- closing the top only consumes its own sentinel ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.open('detail');
  history.open('download');
  history.close('download');

  assert.equal(browser.backCount, 1);
  assert.deepEqual(history.openStack, ['detail']);

  // The answering pop must not close `detail`: that overlay is still open and the reader
  // did not ask for it to go.
  assert.equal(history.handlePop(), undefined, 'a self-issued back does not cascade');
  assert.deepEqual(history.openStack, ['detail'], 'the lower overlay is still open');
}

// ---- closing a *lower* overlay never navigates ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.open('detail');
  history.open('download');
  history.close('detail');

  assert.equal(browser.backCount, 0, 'a sentinel with one above it cannot be consumed alone');
  assert.deepEqual(history.openStack, ['download']);
}

// ---- a StrictMode remount keeps one sentinel, and the departure is cancelled ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  // mount -> cleanup -> mount, which is the sequence React runs under StrictMode.
  history.open('detail');
  history.forgetSoon('detail');
  history.open('detail');
  browser.flushDeferred();

  assert.equal(browser.length, 2, 'the remount does not push a second entry');
  assert.deepEqual(history.openStack, ['detail'], 'and the deferred departure left the sentinel');
  assert.equal(
    browser.pressBack(history),
    'detail',
    'so one Back is still enough to dismiss the overlay',
  );
}

// ---- a real unmount drops the sentinel without navigating ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.open('detail');
  history.forgetSoon('detail');
  browser.flushDeferred();

  assert.equal(browser.backCount, 0, 'nothing to dismiss, so nothing is traversed');
  assert.deepEqual(history.openStack, []);
  // The entry itself cannot be removed from the browser's history; it is abandoned in
  // place. What must hold is that it is inert: the press spends itself on nothing.
  assert.equal(history.handlePop(), undefined, 'the abandoned entry dismisses nothing');
}

// ---- an abandoned sentinel spends one Back press, and only one ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.open('detail');
  history.forgetSoon('detail');
  browser.flushDeferred();

  // The entry cannot be removed, so the reader's next Back lands on it and finds nothing to
  // dismiss - one press is spent. What must not happen is a second overlay or a route being
  // consumed by it: the loop stops after the single traversal the reader made.
  assert.equal(browser.pressBack(history), undefined, 'an abandoned entry dismisses nothing');
  assert.equal(browser.cursor, 0, 'and the press spent itself on that one entry');
  assert.equal(browser.backCount, 1, 'the module issued no traversal of its own');
}

// ---- `replace` is not a separate case ----
//
// `replace` rewrites the entry the reader is on rather than adding one, so the entry below a
// sentinel stops being the one the overlay was opened over. Both a push and a replace change
// the router's key, which is the signal this module compares - so the reverted-apply case
// above is the same branch rather than a rule of its own.

// ---- opening an id twice is one entry ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.open('detail');
  history.open('detail');

  assert.equal(browser.length, 2, 'a repeated open is idempotent, not a second entry');
  assert.deepEqual(history.openStack, ['detail']);
}

// ---- closing an id that is not open is a no-op ----
{
  const browser = createFakeHost();
  const history = createOverlayHistory(browser.host);

  history.close('detail');
  assert.equal(browser.backCount, 0);
  assert.deepEqual(history.openStack, []);
}

console.log('overlay history: all cases passed');
