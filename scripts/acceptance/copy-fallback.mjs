import { FAKE_CLIENT_SECRET } from '../fake-cpa.mjs';

/**
 * Copying a key works without the Clipboard API. This context holds no clipboard
 * permission, so the async API is refused exactly as on a plain-HTTP origin, where
 * `navigator.clipboard` is undefined, and the console's selection path has to carry the
 * copy. Which path is chosen is `scripts/test-clipboard.ts`; that the selection path puts
 * the value on the clipboard in a real document is only observable here.
 */
export async function runCopyFallbackAcceptance({ appURL, page, check, checkEventually }) {
  await page.goto(`${appURL}/api-keys`, { waitUntil: 'domcontentloaded' });
  const firstRow = page.locator('.config-api-keys-table .ant-table-row').first();
  await firstRow.waitFor({ state: 'visible', timeout: 15_000 });
  await firstRow.getByRole('button', { name: /^(复制|Copy)$/ }).click();
  await checkEventually(
    'the copy control reports a copy it made',
    async () => (await page.locator('.omc-toast').getByText(/已复制到剪贴板|Copied to clipboard/).count()) > 0,
    { label: "the copy control's success message" },
  );
  // Read back through the browser's own paste pipeline: a toast proves the handler ran,
  // the pasted value proves the key reached the clipboard. Pasting needs no permission.
  await page.evaluate(() => {
    const probe = document.createElement('input');
    probe.setAttribute('data-copy-probe', '');
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    document.body.appendChild(probe);
    probe.focus();
  });
  await page.keyboard.press('Control+V');
  const pasted = await page.evaluate(() => document.querySelector('input[data-copy-probe]')?.value ?? '');
  await page.evaluate(() => document.querySelector('input[data-copy-probe]')?.remove());
  // Lengths rather than values, so the log never echoes a credential shape.
  check('the copy control puts the key on the clipboard', pasted === FAKE_CLIENT_SECRET,
    `pastedLength=${pasted.length} expectedLength=${FAKE_CLIENT_SECRET.length}`);
}
