/**
 * The request list's rendered claims: the rows the fixture seeded, the verdict
 * colour a long agent latency must not carry, which provider key answered an
 * API-key request, and the summary strip that is gone.
 */
import { maskKeyText } from '../../../web/src/utils/maskKey.ts';
import { FAKE_PROVIDER_SECRET } from '../../fake-cpa.mjs';

export async function requestListSection(context) {
  const {
    page,
    check,
    smokeOnly,
    consoleErrors,
    pageErrors,
    onSmokeComplete,
  } = context;


  // ---- request list: verdict colours, ordering, and the live tail ----
  // These four behaviours were each reported as a bug, so each gets a browser
  // check rather than only a unit test.
  // Find the scroll holder by behaviour rather than by class: the list is
  // virtualized and the scrolling element is Listy's own holder nested inside
  // the wrapper, so naming it by class couples the check to component internals.

  // The list is virtualized, so only the visible window of rows is in the DOM;
  // the footer reports the real page size.
  const visibleRows = await page.locator('.request-row').count();
  const footerText = await page.locator('.request-pagination span').first().innerText();
  check('request list renders seeded records', visibleRows >= 2, `visibleRows=${visibleRows}`);
  check('the whole seeded page is loaded', /50/.test(footerText), `footer="${footerText}"`);

  if (smokeOnly) {
    check('browser console has no errors in the smoke path', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('browser has no page errors in the smoke path', pageErrors.length === 0, pageErrors.join(' | '));
    onSmokeComplete();
  }

  // Latency carries no verdict colour. The fixture's slowest row is a nine-minute
  // agent request, and an absolute threshold used to paint it amber. It is located
  // by its own latency rather than by position: the list is ordered by request
  // time, so the slowest request is not the first row.
  const latencyColours = await page
    .locator('.request-row .req-latency-val')
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
  const warnColour = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--warn)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  const latencyTexts = await page.locator('.request-row .req-latency-val').allInnerTexts();
  const slowestLatency = latencyTexts.reduce((worst, text) => {
    const seconds = /m /.test(text)
      ? Number.parseFloat(text) * 60
      : Number.parseFloat(text) || 0;
    return Math.max(worst, seconds);
  }, 0);
  check('long agent latency is rendered without a warning colour', !latencyColours.includes(warnColour), `colours=${latencyColours.length}`);
  // Anchored so the assertion above cannot pass vacuously on an empty list.
  check('a long agent request really is on screen', slowestLatency > 60, `slowest=${slowestLatency}s`);

  // The window states no ordering label: the list's order now matches the time
  // column it displays, so there is nothing to explain. The absence is pinned.
  check('the window states no ordering label', (await page.locator('.request-order-hint').count()) === 0);
  // The summary strip is gone, so the request page states no verdict of its own.
  check('no KPI summary strip remains', (await page.locator('.request-summary, .req-kpi-item').count()) === 0);
  check('the removed strip left no dead column of totals', (await page.locator('.req-kpi-val').count()) === 0);

  // ---- which of the provider's keys answered ----
  // The fixture carries one record answered by a credential the fake CPA
  // configures, and one whose auth index nothing claims. The first must print the
  // mask of that credential's key, the second must print no key line at all: a
  // request the console cannot attribute must stay silent rather than guess.
  const keyRow = page.locator('.request-row').filter({ hasText: 'fixture-provider-key' }).first();
  await keyRow.waitFor({ state: 'visible', timeout: 15_000 });
  const providerKeyText = await keyRow.locator('.req-provider-key').innerText();
  const expectedMask = maskKeyText(FAKE_PROVIDER_SECRET);
  check(
    "a request row names the provider key that answered it",
    providerKeyText === expectedMask,
    `provider key cell="${providerKeyText}" expected="${expectedMask}"`,
  );
  check(
    'the provider key cell carries the mask and nothing else',
    !providerKeyText.includes(FAKE_PROVIDER_SECRET),
    `provider key cell="${providerKeyText}"`,
  );
  const attributedRowText = await keyRow.innerText();
  check(
    'the attributed row itself carries no provider key',
    !attributedRowText.includes(FAKE_PROVIDER_SECRET),
    `row text="${attributedRowText.slice(0, 200)}"`,
  );
  const unattributedRow = page.locator('.request-row').filter({ hasText: 'fixture-provider-key-absent' }).first();
  await unattributedRow.waitFor({ state: 'visible', timeout: 15_000 });
  check(
    'an unattributable request prints no provider key',
    (await unattributedRow.locator('.req-provider-key').count()) === 0,
    `key cells on that row=${await unattributedRow.locator('.req-provider-key').count()}`,
  );
  // An OAuth record has no provider key: its credential is the account the row
  // already names, so the key line must not appear on it either.
  const oauthRow = page.locator('.request-row').filter({ hasText: 'fixture-plugin-provider' }).first();
  check(
    'an OAuth request prints no provider key',
    (await oauthRow.locator('.req-provider-key').count()) === 0,
    `key cells on that row=${await oauthRow.locator('.req-provider-key').count()}`,
  );
}
