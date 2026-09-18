/**
 * Key-management release acceptance.
 *
 * The orchestration file owns process and browser lifecycle; this module owns
 * the key list, alias, draft-save and request-filter flow. The caller supplies
 * only the live browser handles and the fixture identities.
 */
/**
 * The stored identity behind an operator-assigned caller name.
 *
 * The applied filter must commit the fingerprint the usage records carry, and the
 * name is a label the API resolves from that same fingerprint. Reading it out of a
 * captured facet response is what makes the assertion exact: "not the alias" would
 * still pass for a mask, a truncated identifier, or another key's fingerprint.
 */
function callerFingerprintFromResponses(responseBodies, alias) {
  for (const body of responseBodies) {
    if (!body.includes('"api_group_keys"')) continue;
    let parsed;
    try { parsed = JSON.parse(body); } catch { continue; }
    const entries = parsed?.facets?.api_group_keys;
    if (!Array.isArray(entries)) continue;
    const match = entries.find((entry) => entry?.alias === alias);
    if (typeof match?.value === 'string' && match.value) return match.value;
  }
  return undefined;
}

export async function runKeyManagementAcceptance({
  appURL,
  page,
  check,
  checkEventually,
  responseBodies,
  clientKeyAlias,
  clientKeySecret,
}) {
    // ---- key management: the list is rendered from the config document ----
    // The page reads `api-keys` out of the parsed config YAML rather than calling
    // the immediate `/management/api-keys` facade, so a sequence node read without
    // unwrapping renders as an empty list no matter how many keys CPA holds. The
    // fixture keeps the config round trip stateful so this reads the real path.
    await page.goto(`${appURL}/api-keys`, { waitUntil: 'domcontentloaded' });
    await page.locator('.keys-page').first().waitFor({ state: 'visible', timeout: 15000 });
    // The console has one content column, and this page may not widen it. A page-level
    // `max-width: 100%` on the page root used to win by source order against
    // `.terminal-page` (CSS module styles load after the stylesheet), which made this
    // surface render the full width of the content area - 244px wider than every other
    // page at a 1920px viewport. Measured against the providers page rather than against
    // a literal, so what this pins is the convention instead of a magic number.
    const keysColumn = await page.locator('.keys-page').evaluate((el) => getComputedStyle(el).maxWidth);
    await page.goto(`${appURL}/ai-providers`, { waitUntil: 'domcontentloaded' });
    const providersPage = page.locator('.providers-page').first();
    await providersPage.waitFor({ state: 'visible', timeout: 15000 });
    const providersColumn = await providersPage.evaluate((el) => getComputedStyle(el).maxWidth);
    check(
      'key management uses the console content column rather than the viewport',
      keysColumn === providersColumn && keysColumn !== '100%',
      `keys=${keysColumn} providers=${providersColumn}`,
    );
    await page.goto(`${appURL}/api-keys`, { waitUntil: 'domcontentloaded' });
    await page.locator('.keys-page').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('.config-api-keys-table .ant-table-row').first().waitFor({ state: 'visible', timeout: 15000 });
    const keyRows = await page.locator('.config-api-keys-table .ant-table-row').count();
    check('key management lists the client keys CPA reports', keyRows === 1, `rows=${keyRows}`);
    // Addressed by a data hook rather than by its class: the count element's class is
    // owned by a CSS module and is hashed at build time, so a class selector here would
    // silently match nothing and time out instead of asserting.
    const keySummary = await page.locator('.keys-page [data-testid="keys-count"]').first().innerText();
    check('key management counts the listed keys', /(^|\D)1(\D|$)/.test(keySummary), `summary="${keySummary}"`);
    // The surface is one container: a card holding another card holding a toolbar
    // is the nesting the open-list rule exists to prevent, and it is what made the
    // old page read as a frame inside a frame.
    const containerCount = await page.locator('.keys-page .ant-card').count();
    const nestedPanelCount = await page.locator('.keys-page .settings-group').count();
    check(
      'key management renders one container rather than nested frames',
      containerCount === 1 && nestedPanelCount === 0,
      `cards=${containerCount} nested=${nestedPanelCount}`,
    );
    // ...and it keeps that card's own inset, which is what makes this list exactly as
    // wide as the list every other page renders.
    const cardBodyPadding = await page
      .locator('.keys-page .ant-card-body')
      .first()
      .evaluate((el) => getComputedStyle(el).paddingLeft);
    check(
      'the key list keeps the card inset other lists use',
      cardBodyPadding === '20px',
      `padding=${cardBodyPadding}`,
    );
    // Masked by default: the row shows a preview, never the stored secret.
    const keyText = await page.locator('.config-api-keys-table .config-key-text').first().innerText();
    check(
      'key management masks the stored secret',
      keyText.includes('•') && keyText !== clientKeySecret,
      `text="${keyText}"`,
    );
    // The mask is the server's own shape, not a second opinion about it. The key
    // list and the request list read different sources for the same key, so an
    // independent implementation here would silently make one key look like two.
    // It is also a fixed shape: a mask that tracked the secret's length would print
    // the length of every key in the list.
    const expectedMask = `${clientKeySecret.slice(0, 8)}••••••••${clientKeySecret.slice(-4)}`;
    check(
      'the key list renders the mask shape the server defines',
      keyText.trim() === expectedMask,
      `text="${keyText}" expected="${expectedMask}"`,
    );
    // Revealing must not move the row: the mask and the secret are the same shape
    // and the box that holds them has a fixed width.
    const keyCellBefore = await page.locator('.config-api-keys-table .config-key-box').first().boundingBox();
    const nameCellBefore = await page.locator('.config-api-keys-table .ant-table-row').first().locator('td').first().boundingBox();
    // Reveal is the operator's explicit action, and then the full value is shown.
    // Located by its accessible name rather than by position: the row now carries
    // several actions, so "the first button" is no longer the reveal control.
    await page.getByRole('button', { name: /显示密钥|Reveal secret/ }).first().click();
    const revealedKey = await page.locator('.config-api-keys-table .config-key-text').first().innerText();
    check('revealing a key shows its full value', revealedKey.trim() === clientKeySecret, `text="${revealedKey}"`);
    const keyCellAfter = await page.locator('.config-api-keys-table .config-key-box').first().boundingBox();
    const nameCellAfter = await page.locator('.config-api-keys-table .ant-table-row').first().locator('td').first().boundingBox();
    check(
      'revealing a key does not resize the key column or move the row',
      Math.round(keyCellBefore.width) === Math.round(keyCellAfter.width)
        && Math.round(keyCellBefore.x) === Math.round(keyCellAfter.x)
        && Math.round(nameCellBefore.width) === Math.round(nameCellAfter.width),
      `keyBox=${Math.round(keyCellBefore.width)}->${Math.round(keyCellAfter.width)} name=${Math.round(nameCellBefore.width)}->${Math.round(nameCellAfter.width)}`,
    );
    responseBodies.length = 0;

    // ---- key aliases: name a key, then see that name on its request records ----
    // This is the whole feature end to end: the name is written through the UI,
    // resolved server-side against the fingerprint the usage records carry, and
    // rendered in the request list in place of the mask. The filter identity must
    // stay the fingerprint, so the assertion also pins that the visible name and
    // the value being filtered on are not the same thing.
    const aliasRow = page.locator('.config-api-keys-table .ant-table-row').first();
    check(
      'an unnamed key states that it is unnamed rather than showing a blank',
      (await aliasRow.locator('td').first().innerText()).trim().length > 0,
      `name="${await aliasRow.locator('td').first().innerText()}"`,
    );
    // One editor holds both of a key's editable parts; it is the row's edit control,
    // and the name cell opens the same dialog.
    await aliasRow.getByRole('button', { name: /编辑|Edit/ }).click();
    const renameInput = page.locator('.ant-modal input#gateway-key-alias');
    await renameInput.waitFor({ state: 'visible', timeout: 10000 });
    await renameInput.fill(clientKeyAlias);
    await page.locator('.ant-modal .ant-btn-primary').click();
    await checkEventually(
      'the new name is saved and shown in the key table',
      async () => (await aliasRow.locator('td').first().innerText()).includes(clientKeyAlias),
      { detail: async () => `name="${await aliasRow.locator('td').first().innerText()}"` },
    );
    // The masked secret is still what the key column shows by default: naming a key
    // must not turn the table into a secret display. The reveal toggled earlier in
    // this same run is still on, so it is switched back off first - otherwise this
    // check would assert against a state the previous check deliberately created.
    await page.getByRole('button', { name: /隐藏密钥|Hide secret/ }).first().click();
    const namedKeyText = await page.locator('.config-api-keys-table .config-key-text').first().innerText();
    check(
      'naming a key does not reveal the secret',
      namedKeyText.includes('•') && !namedKeyText.includes(clientKeySecret),
      `text="${namedKeyText}"`,
    );
    responseBodies.length = 0;

    // Adding a key is a draft operation: the modal must generate a valid value,
    // expose the value it will submit, and leave the saved configuration untouched
    // when cancelled. It must not require another silent reveal of an existing key.
    const addKeyButton = page.locator('.keys-page button').filter({ hasText: /Add key|添加|新增/i }).first();
    await addKeyButton.click();
    const keyModal = page.locator('.ant-modal:visible');
    await keyModal.waitFor({ state: 'visible', timeout: 5000 });
    check('key add dialog labels the input it submits', (await keyModal.locator('label[for="gateway-key-value"]').count()) === 1);
    await keyModal.locator('button').filter({ hasText: /Generate random key|生成随机密钥/i }).click();
    const generatedKey = await keyModal.locator('#gateway-key-value').inputValue();
    check('key add dialog generates a non-empty gateway key', /^sk-cpa-[0-9a-f]{32}$/.test(generatedKey), `key=${generatedKey.slice(0, 10)}…`);
    check('key add dialog enables save only for a non-empty key', !(await keyModal.locator('.ant-btn-primary').isDisabled()));
    await keyModal.locator('.ant-modal-footer .ant-btn-default').first().click();
    await keyModal.waitFor({ state: 'hidden', timeout: 5000 });
    check('cancelling key add leaves the saved list unchanged', (await page.locator('.config-api-keys-table .ant-table-row').count()) === keyRows);

    // ---- the request list shows the name instead of the mask ----
    await page.goto(`${appURL}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
    await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
    // The row is located by its own request id rather than by position. The
    // key-attributed fixture record is not the newest one in the window, and a
    // position-based read would silently assert against whichever row happened to
    // sort first.
    const callerRow = page.locator('.request-row').filter({ hasText: 'fixture-key-caller' }).first();
    await callerRow.waitFor({ state: 'visible', timeout: 15000 });
    const keyColumnText = await callerRow.locator('.req-key-val').innerText();
    check(
      'the request list labels the caller with its assigned name',
      keyColumnText.includes(clientKeyAlias),
      `key column="${keyColumnText}"`,
    );
    check(
      'the request list no longer prints the raw mask for a named key',
      !keyColumnText.includes('••'),
      `key column="${keyColumnText}"`,
    );
    // A different, unnamed caller still reads as a mask (or an em dash), so the
    // alias has not replaced the fallback for every row.
    const otherKeyText = await page.locator('.request-row .req-key-val').first().innerText();
    check(
      'an unnamed row keeps its non-alias label',
      !otherKeyText.includes(clientKeyAlias),
      `first row key column="${otherKeyText}"`,
    );

    // The filter value must remain the fingerprint: the visible name is a label,
    // and a filter that meant something different from what it displays is exactly
    // the ambiguity aliases exist to remove. The caller facet lives in the filter
    // drawer, which is the surface an operator actually reaches it through; the row
    // is addressed by its stable control id rather than by label text.
    await page.locator('.req-more-filters').click();
    await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#req-multi-api_key').click();
    const aliasOption = page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: clientKeyAlias })
      .first();
    await aliasOption.waitFor({ state: 'visible', timeout: 10000 });
    // Asserted by acting on it rather than by a separate visibility probe: antd re-renders
    // the virtualised dropdown as the search settles, so an isVisible() read taken right
    // after waitFor can sample a detached node and report false for an option that is there.
    // Clicking it is both the check and the next step.
    const aliasOptionText = await aliasOption.innerText();
    check('the caller filter offers the assigned name', aliasOptionText.includes(clientKeyAlias), `option="${aliasOptionText}"`);
    await aliasOption.click();
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="req-filter-apply"]').click();
    await checkEventually(
      'applying the named caller commits an api_key filter',
      async () => new URL(page.url()).searchParams.get('api_key') !== null,
      { detail: () => `url=${new URL(page.url()).search}` },
    );
    const filteredUrl = new URL(page.url()).search;
    const appliedCaller = new URL(page.url()).searchParams.get('api_key');
    const expectedFingerprint = callerFingerprintFromResponses(responseBodies, clientKeyAlias);
    check(
      'the filter value is the stored fingerprint rather than the displayed name',
      expectedFingerprint !== undefined &&
        appliedCaller === expectedFingerprint &&
        appliedCaller !== clientKeySecret &&
        !filteredUrl.includes(encodeURIComponent(clientKeyAlias)),
      `url=${filteredUrl} fingerprint=${expectedFingerprint ?? 'not captured'}`,
    );
    // The chip names the key the way the list does, so the applied filter is
    // readable without decoding a fingerprint by hand.
    await checkEventually(
      'the applied filter chip shows the assigned name',
      async () => (await page.locator('.req-filter-chip').first().innerText()).includes(clientKeyAlias),
      { detail: async () => `chip="${await page.locator('.req-filter-chip').first().innerText()}"` },
    );
    // After the filter is applied the list holds only that key's traffic, so every
    // visible key cell must carry the name. Reading all of them also catches a
    // partial resolution, where only some rows were labelled.
    await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
    const filteredKeyTexts = await page.locator('.request-row .req-key-val').allInnerTexts();
    check(
      'every filtered row carries the assigned name',
      filteredKeyTexts.length > 0 && filteredKeyTexts.every((text) => text.includes(clientKeyAlias)),
      `key cells=${JSON.stringify(filteredKeyTexts)}`,
    );
    await page.locator('.req-clear-all-chips').click();
    responseBodies.length = 0;

    // ---- removing a key is the only irreversible action the list offers ----
    // There is no disabled state to park a key in, so the confirmation has to carry
    // the consequence: CPA drops the key and this console keeps no copy of the
    // value. The check cancels rather than confirming: what it asserts is the copy
    // and that nothing was written, not that deletion works.
    await page.goto(`${appURL}/api-keys`, { waitUntil: 'domcontentloaded' });
    const listRow = page.locator('.config-api-keys-table .ant-table-row').first();
    await listRow.waitFor({ state: 'visible', timeout: 15000 });
    const rowsBeforeDelete = await page.locator('.config-api-keys-table .ant-table-row').count();
    await listRow.getByRole('button', { name: /更多操作|More actions/ }).click();
    // Addressed as a menu item rather than by text: the label and its wrapper span both
    // read as "删除", which is a strict-mode violation in a click locator.
    await page.locator('.ant-dropdown:visible').getByRole('menuitem', { name: /删除|Delete/ }).click();
    const deleteConfirm = page.locator('.ant-popover:visible');
    await deleteConfirm.waitFor({ state: 'visible', timeout: 5000 });
    const deleteCopy = await deleteConfirm.innerText();
    check(
      'the removal confirmation states that the key cannot be recovered',
      /无法恢复/.test(deleteCopy) || /cannot be recovered/i.test(deleteCopy),
      `copy="${deleteCopy.replace(/\n/g, ' ')}"`,
    );
    // The label is matched with an optional inner space: antd inserts one between the two
    // characters of a two-character label, so the accessible name reads "取 消".
    await deleteConfirm.getByRole('button', { name: /取\s*消|Cancel/ }).click();
    await deleteConfirm.waitFor({ state: 'hidden', timeout: 5000 });
    check(
      'cancelling the removal leaves the key list unchanged',
      (await page.locator('.config-api-keys-table .ant-table-row').count()) === rowsBeforeDelete,
      `rows=${rowsBeforeDelete}`,
    );
}
