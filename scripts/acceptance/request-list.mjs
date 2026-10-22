/**
 * The request list over the seeded database: the rows render, the server owns the window
 * end even when the browser's clock is behind, and a provider key appears only as its
 * mask, on the row it answered and nowhere else.
 */
import { maskKeyText } from '../../web/src/utils/maskKey.ts';
import { FAKE_PROVIDER_SECRET } from '../fake-cpa.mjs';

export async function runRequestListAcceptance({ appURL, page, check }) {
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15_000 });

  // The list is virtualized, so only the visible window of rows is in the DOM;
  // the footer reports the real page size.
  const visibleRows = await page.locator('.request-row').count();
  const footerText = await page.locator('.request-pagination span').first().innerText();
  check('request list renders seeded records', visibleRows >= 2, `visibleRows=${visibleRows}`);
  check('the whole seeded page is loaded', /50/.test(footerText), `footer="${footerText}"`);

  // A browser whose clock runs behind the server's must still see the newest
  // records. The list used to resolve its window's end on the browser's clock, so
  // every record newer than that clock was filtered out and stayed out through any
  // number of refreshes. The seeder stamps records on the server's clock, the
  // newest a few minutes ago, so a half-hour lag hid most of them.
  const skewMs = 30 * 60_000;
  const skewedPage = await page.context().newPage();
  try {
    await skewedPage.addInitScript((offset) => {
      const readClock = Date.now.bind(Date);
      Date.now = () => readClock() - offset;
    }, skewMs);
    const listRead = skewedPage.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith('/api/v1/usage/events') && response.ok(),
      { timeout: 15_000 },
    );
    await skewedPage.goto(`${appURL}/usage/events?preset=1h`, { waitUntil: 'domcontentloaded' });
    const response = await listRead;
    const sent = new URL(response.url()).searchParams;
    check(
      'a preset read leaves the window end to the server',
      sent.get('preset') === '1h' && !sent.has('from') && !sent.has('to'),
      `query=${sent.toString()}`,
    );
    const body = await response.json();
    const newestMs = Math.max(0, ...(body.items ?? []).map((item) => item.timestamp_ms));
    check(
      'a browser clock running behind the server still lists the newest records',
      newestMs > Date.now() - skewMs,
      `newest=${new Date(newestMs).toISOString()} items=${body.items?.length ?? 0}`,
    );
  } finally {
    await skewedPage.close();
  }

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
