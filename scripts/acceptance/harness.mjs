/** Condition and layout waits shared by deterministic browser acceptance. */

/** The budget for a condition on a page that is already up: long enough for the app to settle, and
 *  short enough to keep a genuinely broken expectation from stalling the run to its job timeout. */
export const CONDITION_TIMEOUT_MS = 10_000;

/**
 * The budget for the first render after a navigation or reload, as distinct from a condition on a
 * page that is already up.
 *
 * In development the largest routes ship one module per file: a Playground reload dispatches about
 * two hundred requests, and a trace on a loaded host measured the page mounting 11.5s after the
 * reload while the restored state itself was correct as soon as it rendered. CI runs two workers on
 * a two-core runner, so that first render has less headroom than the measurement, not more. The claim
 * these probes make - a refresh restores the run - needs a boot budget rather than Playwright's 10s
 * action timeout. Every condition after the boot keeps `CONDITION_TIMEOUT_MS`.
 */
export const PAGE_BOOT_TIMEOUT_MS = 30_000;

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
 * Waits for the first render after a navigation or reload, within the boot budget.
 *
 * `isVisible()` answers immediately, so the polling loop owns the deadline and a shortage reports the
 * label the caller wrote instead of a locator's own timeout. Every wait after this one stays on
 * `CONDITION_TIMEOUT_MS`.
 */
export async function untilBooted(locator, label) {
  return until(() => locator.isVisible(), { label, timeoutMs: PAGE_BOOT_TIMEOUT_MS });
}

/**
 * A locator's text once it is attached, or the empty string before that.
 *
 * `innerText()` on a locator that is not attached spends its own action timeout before throwing, so a
 * predicate that reads text while a page is still booting would sit inside that timeout instead of
 * polling. Reading the count first keeps the loop in charge of the deadline.
 */
export async function attachedText(locator) {
  return await locator.count() ? locator.innerText() : '';
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

  return { check, checkEventually, checks, failures };
}
