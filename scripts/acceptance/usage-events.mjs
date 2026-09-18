import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pastDeadline, sleep } from './harness.mjs';
import {
  EVENT_AUTO_REFRESH_MS,
  EVENT_SEARCH_DEBOUNCE_MS,
} from '../../web/src/types/usageEventCadence.ts';

import { filterDimensionsSection } from './usage-events/filterDimensions.mjs';
import { filterPanelSection } from './usage-events/filterPanel.mjs';
import { liveTailSection } from './usage-events/liveTail.mjs';
import { refreshAndLayoutSection } from './usage-events/refreshAndLayout.mjs';
import { requestListSection } from './usage-events/requestList.mjs';
import { searchAndRejectionsSection } from './usage-events/searchAndRejections.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Request-record release acceptance: ordering, live-tail/Hold behaviour, filter
 * and pagination races, and responsive layout. The top-level runner owns the
 * browser and fake CPA; this module owns the request-record domain flow.
 */
export async function runUsageEventsAcceptance({
  auditPage,
  appURL,
  page,
  check,
  checkEventually,
  checkHoldsFor,
  responseBodies,
  providerSecrets,
  until,
  measureStable,
  settleLayout,
  smokeOnly,
  consoleErrors,
  pageErrors,
  onSmokeComplete,
}) {
  await auditPage(page, responseBodies, '/usage/events', '.usage-events-page', { pageSecrets: providerSecrets });

  /**
   * Clicks a toolbar control once the filter row has stopped re-flowing.
   *
   * `.request-filters` is a wrapping flex row, so adding or removing a filter re-wraps it, which moves
   * the controls and the list beneath them. A click issued straight after a filter change can therefore
   * land on geometry that has already changed: measured, Playwright retried for its full 30s and reported
   * a table header covering the button's centre, because the point it had computed belonged to the
   * previous layout.
   *
   * Two conditions, both real rather than a sleep: the control's own box has stopped changing, and the
   * control is the element at its own centre. The second is the property a click needs, and stating it
   * here turns a genuine overlap into a named diagnostic instead of an opaque "intercepts pointer
   * events" after thirty seconds.
   *
   * A control in the page header is first brought back to the view it is clicked in. The console folds
   * that header - filters included - into full-screen mode while the list is scrolled, and this suite
   * scrolls the list on purpose to prove the live-tail behaviour. A folded control keeps its layout box
   * (it is clipped to zero height and its header takes no pointer events, not detached), so aiming at it
   * lands on the row underneath: that is the reader's mode, not the overlap this function exists to
   * name. The console leaves that mode through a return to the top - the list's own pill, which is also
   * what expands the header - so the same gesture is used here, and a failure stays a claim about
   * coverage.
   */

  const clickSettled = async (selector, label) => {
    const control = page.locator(selector);
    await control.waitFor({ state: 'visible', timeout: 15_000 });
    const foldedHeader = page.locator('.request-collapsible-header.is-collapsed');
    const isFolded = await page.evaluate(
      (target) => Boolean(document.querySelector(target)?.closest('.request-collapsible-header.is-collapsed')),
      selector,
    );
    if (isFolded) {
      const returnPill = page.locator('.req-back-to-top-btn');
      if ((await returnPill.count()) > 0) {
        await returnPill.first().click();
      } else {
        // Folded with the list already at the top: the console folds by scrolling and unfolds by
        // returning to the top, and the pill only exists while the list is scrolled, so this state
        // offers no in-page way back. A fresh load is the view the console gives a reader who opens
        // the page, which is what the interaction needs.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15_000 });
      }
      await foldedHeader.waitFor({ state: 'detached', timeout: 5_000 });
    }
    await measureStable(
      async () => {
        const box = await control.boundingBox();
        return box
          ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`
          : 'absent';
      },
      { page, label: `${label} to stop moving`, settleMs: 50 },
    );
    const covering = await page.evaluate((target) => {
      const element = document.querySelector(target);
      if (!element) return 'nothing (the control is gone)';
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!top) return 'nothing (the point is outside the viewport)';
      return top === element || element.contains(top) || top.contains(element)
        ? null
        : `${top.tagName.toLowerCase()}.${String(top.className)}`;
    }, selector);
    if (covering) throw new Error(`${label} is covered by ${covering} at its own centre`);
    await control.click();
  };

  const listScroller = async () => {
    const handle = await page.evaluateHandle(() => {
      const root = document.querySelector('.request-list-host');
      if (!root) return null;
      const candidates = [root, ...root.querySelectorAll('*')];
      // A virtualized holder reports `overflow: hidden` yet still carries the
      // full content height and accepts programmatic scrolling, so the test is
      // geometry, not the overflow property.
      return (
        candidates.find((node) => {
          const style = getComputedStyle(node);
          return (
            /auto|scroll|hidden/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 20
          );
        }) ?? null
      );
    });
    return handle.asElement();
  };
  const describeListTree = async () =>
    page.evaluate(() => {
      const root = document.querySelector('.request-list-host');
      if (!root) return 'no .request-list-host';
      return [root, ...root.querySelectorAll('*')]
        .slice(0, 6)
        .map((node) => {
          const style = getComputedStyle(node);
          return `${node.className || node.tagName}|overflowY=${style.overflowY}|h=${node.clientHeight}/${node.scrollHeight}`;
        })
        .join(' :: ');
    });
  const rowTimestamps = async () => {
    const values = await page.locator('.request-row .req-col-time time').evaluateAll((nodes) =>
      nodes.map((node) => Date.parse(node.getAttribute('datetime') ?? '')),
    );
    return values.filter((value) => Number.isFinite(value));
  };

  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  const filterSuffix = () => new URL(page.url()).search;
  const initialFilterQuery = filterSuffix();
  const modelFacet = page.locator('.request-filters .req-facet-select').first();
  const providerFacet = page.locator('.request-filters .req-facet-select').nth(1);
  const autoRefreshSwitch = page.locator('#req-auto-refresh');

  /**
   * The flow's shared vocabulary.
   *
   * `clickSettled` and the locators below are the parts every section reaches for,
   * and they are defined once here rather than in each section: a section that
   * measured a control differently from its neighbour would be asserting a
   * different page.
   */
  const context = {
    auditPage,
    appURL,
    page,
    check,
    checkEventually,
    checkHoldsFor,
    responseBodies,
    providerSecrets,
    until,
    measureStable,
    settleLayout,
    smokeOnly,
    consoleErrors,
    pageErrors,
    onSmokeComplete,
    clickSettled,
    listScroller,
    describeListTree,
    rowTimestamps,
    filterSuffix,
    modelFacet,
    providerFacet,
    autoRefreshSwitch,
  };

  // The order is the order these claims have always been made in, and it is a
  // dependency rather than a preference: the filter panel's edits are what the live
  // tail then scrolled away from, and the layout sweeps run last because they resize
  // the viewport the earlier sections measured.
  await requestListSection(context);
  await filterPanelSection(context);
  await liveTailSection(context);
  await filterDimensionsSection(context);
  await searchAndRejectionsSection(context);
  await refreshAndLayoutSection(context);
}
