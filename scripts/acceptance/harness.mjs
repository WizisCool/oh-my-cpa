/**
 * Waiting primitives for the deterministic browser acceptance run.
 *
 * Every check in this suite used to be preceded by a fixed `waitForTimeout`. A
 * fixed sleep is wrong in both directions: it wastes the whole window when the
 * app settles in 20 ms, and it still asserts too early when the app is slower
 * than the author's machine happened to be. This module replaces the sleeps with
 * waits that name the condition the following check actually depends on.
 *
 * The hard part is not the waiting, it is keeping the wait honest. Three cases
 * look alike and must not be collapsed:
 *
 * 1. The app must reach a state. `until(predicate)` - bounded, and it throws on
 *    timeout so a broken expectation fails loudly instead of letting the next
 *    check pass against a page that never moved.
 * 2. The app must reach a state at a point in the audit where a *later* write
 *    could still undo it. `checkHoldsFor` / `holdsFor` - see case 3.
 * 3. The app must *not* change during a window in which it could have. Negative
 *    timing claims ("a draft edit must not rewrite the URL", "a queued keystroke
 *    must not revive a cleared filter") have no positive event to wait for. The
 *    only honest evidence is that nothing changed across the whole window, which
 *    is what `holdsFor` provides.
 *
 * Case 3 is the reason this module cannot simply delete every sleep: some windows
 * are irreducible and the point of the refactor is to say so explicitly rather
 * than leave an anonymous magic number.
 *
 * A transition guard - "the predicate must be false before the wait begins, so a
 * check cannot pass on a state the app was already in" - was tried here and
 * removed, because it cannot work in this harness. By the time a predicate is
 * first evaluated, every awaited Playwright interaction that preceded it (click,
 * key press, dropdown dismissal) has already given the app time to settle, so the
 * starting state is no longer observable: the guard rejected checks whose
 * transition had demonstrably happened. Where a transition must be proven, this
 * suite asserts the starting state as its own check *before* the interacting
 * click, which is also what makes such a check readable.
 */

/** Longer than any single condition this suite waits on, and short enough to keep
 *  a genuinely broken expectation from stalling the run to its job timeout. */
export const CONDITION_TIMEOUT_MS = 10_000;

/** Bounded polls keep a wait cheap on a settled page; the ceiling stops a slow
 *  page from being hammered with reads while it catches up. */
const CONDITION_POLL_MIN_MS = 25;
const CONDITION_POLL_MAX_MS = 100;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until `predicate` reports true, then returns its value.
 *
 * The predicate is re-evaluated from Node rather than injected into the page: the
 * assertions in this suite read through Playwright locators and `page.url()`, and
 * a Node-side loop keeps one expression shape for both. It is never swallowed -
 * a predicate that throws is exposed instead of being retried into a timeout.
 */
export async function until(predicate, { label = 'condition', timeoutMs = CONDITION_TIMEOUT_MS } = {}) {
  const first = await predicate();
  if (first) return first;

  const deadline = Date.now() + timeoutMs;
  let pollMs = CONDITION_POLL_MIN_MS;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await sleep(pollMs);
    pollMs = Math.min(pollMs * 2, CONDITION_POLL_MAX_MS);
    const value = await predicate();
    if (value) return value;
  }
}

/**
 * Requires `predicate` to hold for the whole window.
 *
 * Sampling rather than sleeping once and asserting is deliberate: the value is
 * read throughout the window, so a condition that flips and flips back is caught
 * where a single assertion at the end would miss it.
 */
async function holdsFor(predicate, windowMs, { label = 'condition', sampleMs = 50 } = {}) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const value = await predicate();
    if (!value) throw new Error(`${label} stopped holding during a ${windowMs}ms window`);
    if (Date.now() >= deadline) return value;
    await sleep(Math.min(sampleMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Waits past a timer that the app is expected to have fired (or cancelled) by a
 * known deadline. Callers pass a value derived from the same constant the app
 * uses, so a debounce change cannot leave the suite asserting against the old
 * cadence.
 */
export async function pastDeadline(deadlineMs, { slackMs = 200 } = {}) {
  await sleep(deadlineMs + slackMs);
}

/**
 * Waits for the browser to finish laying out what the caller is about to measure.
 *
 * Two frames is the shortest wait that guarantees layout and paint completed:
 * a ResizeObserver callback runs before paint and re-renders on the next frame,
 * so a single frame can still observe pre-reflow geometry.
 */
export async function settleLayout(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

/**
 * Reads a layout measurement once it has stopped changing, so a responsive reflow
 * cannot be read mid-flight. Replaces the fixed post-resize sleeps with the
 * property those sleeps were guessing at: stability of the value being asserted.
 *
 * `settleMs` is for properties that have no completion event to wait for. A
 * virtualized list keeps filling its window for an unbounded number of frames
 * after a scroll, and two consecutive animation frames can agree on a value that
 * is still growing; requiring the read to hold across a real gap is the only
 * condition available. Callers that need it should say why at the call site.
 */
export async function measureStable(read, { page, label = 'layout measurement', timeoutMs = CONDITION_TIMEOUT_MS, settleMs = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = await read();
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} never stopped changing within ${timeoutMs}ms`);
    }
    await settleLayout(page);
    if (settleMs > 0) await sleep(settleMs);
    const current = await read();
    if (current === previous) return current;
    previous = current;
  }
}

/**
 * Collects results and keeps the exit code honest. Extracted so scenarios can be
 * moved into their own modules without carrying mutable counters around.
 */
export function createChecker() {
  const checks = [];
  const failures = [];

  function check(name, condition, detail = '') {
    checks.push({ name, condition, detail });
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures.push(name);
    return condition;
  }

  const describe = async (detail) => {
    if (typeof detail !== 'function') return detail ?? '';
    try {
      return String(await detail());
    } catch {
      return '<detail unavailable>';
    }
  };

  /**
   * Waits for a condition and reports it as one check.
   *
   * The wait is folded into the check on purpose. Letting a wait throw would
   * abort the whole audit and lose the evidence of every check after it, which is
   * why the sleeps this replaces were allowed to expire quietly: a slow condition
   * should cost one red line, not the rest of the run.
   */
  async function checkEventually(name, predicate, { label = name, timeoutMs = CONDITION_TIMEOUT_MS, detail } = {}) {
    try {
      await until(predicate, { label, timeoutMs });
      check(name, true, await describe(detail));
    } catch (error) {
      check(name, false, `${error.message}${detail ? ` — ${await describe(detail)}` : ''}`);
    }
  }

  /**
   * Asserts that a condition holds for a full window. The companion of
   * `checkEventually` for negative timing claims, which have no positive event to
   * wait for: a draft that must not be written, a queued keystroke that must not
   * land. A window that expires without the condition holding is the failure.
   */
  async function checkHoldsFor(name, predicate, windowMs, { label = name, detail } = {}) {
    try {
      await holdsFor(predicate, windowMs, { label });
      check(name, true, await describe(detail));
    } catch (error) {
      check(name, false, `${error.message}${detail ? ` — ${await describe(detail)}` : ''}`);
    }
  }

  return { check, checkEventually, checkHoldsFor, checks, failures };
}
