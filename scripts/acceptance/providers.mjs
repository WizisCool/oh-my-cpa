
/**
 * Provider-console release acceptance: website metadata, status toggles,
 * consecutive-operation reliability, and two-provider overlap. The top-level
 * runner owns process setup; this module owns the provider domain flow.
 */
export async function runProvidersAcceptance({
  auditPage,
  appURL,
  page,
  check,
  checkEventually,
  responseBodies,
}) {
  await auditPage(page, responseBodies, '/ai-providers', '.providers-page');

  // The provider homepage is console metadata, so the row's own name is the link
  // when one is stored, and it must open safely. Both states are exercised:
  // with a stored website the name becomes a safe external link, and with none
  // it stays plain text rather than becoming a dead link or a link to nowhere.
  const setProviderWebsite = async (value) => {
    const status = await page.evaluate(async (body) => {
      const response = await fetch('/omc/api/v1/preferences/provider_websites', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return response.status;
    }, JSON.stringify(value));
    check('provider website preference is writable through the API', status === 200, `status=${status}`);
  };
  const openProvidersPage = async () => {
    await page.goto(`${appURL}/ai-providers`, { waitUntil: 'domcontentloaded' });
    await page.locator('.providers-page tbody tr').first().waitFor({ state: 'visible', timeout: 15000 });
  };

  await openProvidersPage();
  check(
    'a provider with no website keeps its name as plain text',
    (await page.locator('.providers-page tbody a').count()) === 0,
    `links=${await page.locator('.providers-page tbody a').count()}`,
  );

  // The Meta Muse credential list is a family like claude/codex/gemini, and the
  // page's family labels come from one registry. A family that reaches the API
  // but not that registry would render as a bare row, so the label is asserted
  // from the rendered table rather than from the module.
  const metaRow = page.locator('.providers-page tbody tr', { hasText: 'Meta Muse' }).first();
  await metaRow.waitFor({ state: 'visible', timeout: 15000 });
  check(
    'the Meta Muse family renders with its own protocol label',
    (await metaRow.innerText()).includes('Meta Muse'),
    `row=${await metaRow.innerText()}`,
  );
  // The brand mark too, and from the rendered row rather than from the icon module:
  // the family id reaches the mark through an exact-key table, so a row that carried
  // the label while falling back to the neutral icon would otherwise look correct.
  const metaMarkSrc = (await metaRow.locator('img').first().getAttribute('src')) ?? '';
  check(
    'the Meta Muse family renders the Meta brand mark',
    /meta/i.test(metaMarkSrc),
    `src=${metaMarkSrc || 'none'}`,
  );

  // The codex family's first entry is addressed by the console as `codex-0`; the
  // fixture also configures a second codex entry, so this is a position within a
  // family rather than the deployment's whole provider list.
  await setProviderWebsite({ 'codex-0': 'https://provider.example.test' });
  await openProvidersPage();
  const websiteLink = page.locator('.providers-page tbody a').first();
  await checkEventually(
    'a provider with a website renders its name as a link',
    () => websiteLink.isVisible(),
  );
  const websiteHref = (await websiteLink.getAttribute('href')) ?? '';
  const websiteRel = (await websiteLink.getAttribute('rel')) ?? '';
  const websiteTarget = (await websiteLink.getAttribute('target')) ?? '';
  check(
    'the provider link points at the stored website',
    websiteHref === 'https://provider.example.test',
    `href=${websiteHref}`,
  );
  check(
    'the provider link opens in a new tab without handing over window.opener',
    websiteTarget === '_blank' && websiteRel.includes('noopener') && websiteRel.includes('noreferrer'),
    `target=${websiteTarget} rel=${websiteRel}`,
  );

  // Clearing it returns the row to plain text, so the link is a property of the
  // record rather than of the page having been visited.
  await setProviderWebsite({});
  await openProvidersPage();
  check(
    'clearing the website returns the name to plain text',
    (await page.locator('.providers-page tbody a').count()) === 0,
  );

  // ---- Provider enable/disable: consecutive-operation reliability ----
  //
  // The requirement is that a second click is never lost and that the row never
  // settles on a value the gateway does not hold. The fake CPA now keeps the codex
  // API-key list in memory and replaces it on a write, which is what makes the
  // round trip observable: the toggle disables an entry, re-reads the list, and
  // the entry really is disabled the second time.
  const providerSwitch = page.locator('.providers-page tbody .ant-switch').first();
  await providerSwitch.waitFor({ state: 'visible', timeout: 15000 });

  /** Reads the gateway's own answer for one provider, rather than trusting the page. */
  const providerEnabledFromApi = async (id) => {
    const body = await page.evaluate(() => fetch('/omc/api/v1/management/providers').then((r) => r.json()));
    const row = (body.providers ?? []).find((provider) => provider.id === id);
    return row === undefined ? undefined : !row.disabled;
  };

  /**
   * toggleStatesFromApi reads every codex provider's enabled state keyed by its
   * provider id.
   *
   * Keyed rather than positional on purpose: a provider is addressed by position
   * and that is exactly what shifts when one is deleted, so comparing two
   * position-ordered lists would let a misalignment look like agreement.
   */
  const toggleStatesFromApi = async () => {
    const body = await page.evaluate(() => fetch('/omc/api/v1/management/providers').then((r) => r.json()));
    const states = {};
    for (const provider of body.providers ?? []) {
      if (provider.family === 'codex') states[provider.id] = !provider.disabled;
    }
    return states;
  };

  /**
   * renderedToggleStates reads the switches keyed by the same provider ids, taken
   * from each row's `data-row-key` (the table's `rowKey` is the provider id). Every
   * switch is read through its own row, so a row that reports a state its provider
   * does not hold cannot be hidden by another row's agreement.
   */
  const renderedToggleStates = async () =>
    page.evaluate(() => {
      const states = {};
      for (const row of Array.from(document.querySelectorAll('.providers-page tbody tr'))) {
        const id = row.getAttribute('data-row-key');
        const node = row.querySelector('.ant-switch');
        if (id && node) states[id] = node.getAttribute('aria-checked') === 'true';
      }
      return states;
    });

  /** The provider ids every toggle check in this block is about. */
  const expectEveryProvider = async (states, expected, label) => {
    const ids = Object.keys(expected);
    const mismatched = ids.filter((id) => states[id] !== expected[id]);
    check(
      label,
      ids.length > 0 && mismatched.length === 0,
      mismatched.length === 0
        ? `states=${JSON.stringify(states)}`
        : `mismatched=${JSON.stringify(mismatched.map((id) => ({ id, expected: expected[id], actual: states[id] })))}`,
    );
  };

  const toggleWrites = [];
  const recordToggleWrite = (request) => {
    if (request.method() !== 'PATCH' || !request.url().includes('/management/providers/status')) return;
    try {
      toggleWrites.push(JSON.parse(request.postData() ?? '{}'));
    } catch {
      toggleWrites.push({ unparsable: request.postData() });
    }
  };
  page.on('request', recordToggleWrite);

  const initialEnabled = await providerEnabledFromApi('codex-0');
  check(
    'the provider row starts enabled, so the toggle has somewhere to go',
    initialEnabled === true,
    `enabled=${initialEnabled}`,
  );
  // Every row of the table renders exactly one enable switch. The comparison is
  // between rows and switches rather than against a fixed count, so a fixture that
  // gains a provider does not make this pass by coincidence or fail for a reason
  // it is not about.
  const renderedRows = await page.locator('.providers-page tbody tr').count();
  const renderedSwitches = await page.locator('.providers-page tbody .ant-switch').count();
  check(
    'every provider row renders exactly one enable switch',
    renderedRows > 0 && renderedSwitches === renderedRows,
    `rows=${renderedRows} switches=${renderedSwitches}`,
  );

  // One deliberate click first, to pin the whole round trip before measuring a
  // burst: the click asks for disabled, the write says disabled, the control
  // reports disabled, and the gateway agrees.
  await providerSwitch.click();
  await checkEventually(
    'a click on the switch reports the value that click asked for',
    async () => (await providerSwitch.getAttribute('aria-checked')) === 'false',
    { detail: async () => `aria-checked=${await providerSwitch.getAttribute('aria-checked')}` },
  );
  // The control turns over optimistically, so the rendered state settles before
  // the PATCH is on the wire. Wait for the recorded write instead of reading the
  // array immediately, or this check races the request it is about.
  await checkEventually(
    'the click produces exactly one recorded status write',
    () => toggleWrites.length === 1,
    { detail: () => JSON.stringify(toggleWrites) },
  );
  check(
    'the toggle writes to the codex family at index 0 rather than the row id',
    toggleWrites.length === 1 &&
      toggleWrites[0].family === 'codex' &&
      toggleWrites[0].index === 0 &&
      toggleWrites[0].disabled === true,
    JSON.stringify(toggleWrites),
  );
  // A toggle is addressed by position, so the row's own identity travels with the
  // request. It is what stops a retry from landing on a different provider once a
  // deletion has shifted the positions, and a client that stopped sending it would
  // silently lose that protection.
  check(
    'the toggle carries the identity of the provider it addresses',
    toggleWrites[0]?.expected_auth_index === 'codex-e2e',
    JSON.stringify(toggleWrites[0] ?? null),
  );
  await checkEventually(
    'the gateway itself holds the value the click asked for',
    async () => (await providerEnabledFromApi('codex-0')) === false,
    { detail: async () => `api=${await providerEnabledFromApi('codex-0')}` },
  );
  const settledEnabled = await providerEnabledFromApi('codex-0');
  check(
    'the rendered switch agrees with a fresh read of the providers API',
    (await providerSwitch.getAttribute('aria-checked')) === String(settledEnabled),
    `aria-checked=${await providerSwitch.getAttribute('aria-checked')} api=${settledEnabled}`,
  );

  // The rapid burst: several clicks with no waiting in between, which is the
  // gesture that used to lose an operation. They are dispatched from inside one
  // page script rather than one Playwright call at a time, so an unawaited
  // `click()` cannot serialise the burst behind its own actionability checks and
  // hide the very window being probed. Every click's requested value is recorded
  // in order, so the last entry is exactly "what the operator last asked for".
  const burst = await page.evaluate(() => {
    const node = document.querySelector('.providers-page tbody .ant-switch');
    if (!node) return { clicks: 0, intents: [], accepted: [] };
    const intents = [];
    const accepted = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = node.getAttribute('aria-checked') === 'true';
      const wanted = !before;
      intents.push(wanted);
      accepted.push(!node.disabled);
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    return { clicks: intents.length, intents, accepted };
  });
  check(
    'the rapid burst dispatched every click it intended to',
    burst.clicks === 5,
    `clicks=${burst.clicks}`,
  );
  check(
    'every rapid click remains accepted while the status queue is busy',
    burst.accepted.length === burst.clicks && burst.accepted.every(Boolean),
    `accepted=${burst.accepted.filter(Boolean).length}/${burst.clicks}`,
  );

  const lastIntent = burst.intents[burst.intents.length - 1];
  // The burst is over when the queue has drained, which is observable as "the
  // switch no longer reports a write in flight". Waiting for that first is what
  // keeps the two checks below from passing on a transient: mid-burst the row
  // already shows the newest intent, so an assertion taken then would be green
  // for the wrong reason.
  await checkEventually(
    'the burst stops reporting a write in flight',
    async () => (await providerSwitch.getAttribute('aria-busy')) !== 'true',
    { timeoutMs: 15000, detail: async () => `aria-busy=${await providerSwitch.getAttribute('aria-busy')}` },
  );

  // The requirement, stated directly: once the queue drains, what the row shows is
  // what the last click asked for, and a fresh read of the gateway agrees with it.
  await checkEventually(
    'a rapid burst settles on the value of the last click',
    async () => (await providerSwitch.getAttribute('aria-checked')) === String(lastIntent),
    {
      timeoutMs: 15000,
      detail: async () =>
        `aria-checked=${await providerSwitch.getAttribute('aria-checked')} lastIntent=${lastIntent} writes=${toggleWrites.length} clicks=${burst.clicks}`,
    },
  );
  const burstApiEnabled = await providerEnabledFromApi('codex-0');
  check(
    'after a rapid burst the switch still agrees with the gateway',
    (await providerSwitch.getAttribute('aria-checked')) === String(burstApiEnabled),
    `aria-checked=${await providerSwitch.getAttribute('aria-checked')} api=${burstApiEnabled} writes=${toggleWrites.length}`,
  );
  check(
    'a rapid burst never costs more writes than it had clicks',
    toggleWrites.length > 0 && toggleWrites.length <= burst.clicks,
    `writes=${toggleWrites.length} clicks=${burst.clicks} accepted=${burst.accepted.filter(Boolean).length}`,
  );
  // The coalescing property that makes this a root-cause fix rather than a lock:
  // the clicks arrive in one synchronous script, so no network round trip can
  // resolve between them and the queue has no chance to send each one. The burst
  // therefore costs strictly fewer writes than it had clicks - while still ending
  // on the last click's value, which the checks around this one pin. A queue that
  // fired one request per click (or that dropped the later ones) cannot satisfy
  // both at once.
  check(
    'a rapid burst coalesces instead of writing once per click',
    toggleWrites.length < burst.clicks,
    `writes=${toggleWrites.length} clicks=${burst.clicks}`,
  );
  check(
    'every burst write names the codex family at index 0',
    toggleWrites.every((write) => write.family === 'codex' && write.index === 0),
    JSON.stringify(toggleWrites),
  );
  // The last write the gateway received must be the last click's intent. A queue
  // that dropped the final click, or let an older response win, fails here even
  // when the write count looks healthy.
  const lastWrite = toggleWrites[toggleWrites.length - 1];
  check(
    'the last write the gateway received is the last click intent',
    lastWrite !== undefined && lastWrite.disabled === !lastIntent,
    `lastWrite=${JSON.stringify(lastWrite)} lastIntentEnabled=${lastIntent}`,
  );

  // The status label and the switch are two statements about the same fact on
  // one row, and both read the row's single `resolveEnabled`. A burst is exactly
  // when they could drift apart, so the agreement is asserted rather than assumed.
  const statusCellText = await page.locator('.providers-page tbody tr').first().innerText();
  const switchEnabled = (await providerSwitch.getAttribute('aria-checked')) === 'true';
  check(
    'the status label and the switch agree on the same row',
    switchEnabled ? /Active|正常/.test(statusCellText) : /Disabled|已停用/.test(statusCellText),
    `switch=${switchEnabled} row="${statusCellText.replace(/\s+/g, ' ').trim()}"`,
  );

  // ---- Two different providers toggled at once ----
  //
  // The defect this exercises: CPA has no per-entry write, so a toggle reads the
  // family's whole list and PUTs it back. Two toggles on *different* rows that
  // both read before either wrote submit the same baseline, and the later PUT
  // discards the earlier one - one switch is silently reverted while both
  // requests report success. The per-provider queue cannot help, because it runs
  // different providers concurrently by design.
  //
  // What this check is and is not allowed to claim. The browser cannot force the
  // interleaving: it depends on the two requests overlapping at CPA, and a run
  // where the first write lands before the second reads passes regardless of the
  // gate - verified by removing the gate, which still produced a green run here.
  // So this asserts the outcome the operator cares about (both toggles survive and
  // both rows agree with the gateway) and does not pretend to be the regression
  // for the lost update. That regression is
  // `TestConcurrentProviderTogglesDoNotLoseAWrite` in `internal/api`, which
  // controls the ordering at the fake gateway and fails when the gate is removed.
  // Scoped to the codex family: this block is about one family's whole-list
  // write, and the fixture's other families are not part of the race. Counting
  // the whole table instead would make the check fail for the wrong reason the
  // moment the fixture gains a provider - and pass for the wrong reason if the
  // codex entries were ever removed.
  const codexSwitchCount = await page.locator('.providers-page tbody tr[data-row-key^="codex-"] .ant-switch').count();
  check(
    'the fixture provides two codex toggles to race',
    codexSwitchCount === 2,
    `switches=${codexSwitchCount}`,
  );

  // Each switch is clicked to the opposite of the state its *own row* currently
  // shows, and the intent is recorded per provider id, so the assertion below
  // compares like with like even if the rows are ever reordered or a provider is
  // added.
  const beforeConcurrent = await toggleStatesFromApi();
  const concurrentIntents = await page.evaluate(() => {
    const codexRows = Array.from(document.querySelectorAll('.providers-page tbody tr'))
      .filter((row) => (row.getAttribute('data-row-key') ?? '').startsWith('codex-'));
    const intents = {};
    for (const row of codexRows) {
      const id = row.getAttribute('data-row-key');
      const node = row.querySelector('.ant-switch');
      if (!id || !node) continue;
      intents[id] = node.getAttribute('aria-checked') !== 'true';
    }
    // Dispatched only after every intent is recorded, so the whole burst is one
    // synchronous pass and no round trip can resolve in between.
    for (const row of codexRows) {
      row.querySelector('.ant-switch')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    return intents;
  });

  check(
    'the concurrent race has two codex providers to observe',
    Object.keys(concurrentIntents).length === 2,
    `intents=${JSON.stringify(concurrentIntents)}`,
  );

  // The result is asserted against a fresh read of the gateway rather than the
  // rendered switches, so a row that agrees with itself but not with CPA fails.
  await checkEventually(
    'an overlapping toggle of two providers leaves both changes on the gateway',
    async () => {
      const states = await toggleStatesFromApi();
      return Object.entries(concurrentIntents).every(([id, wanted]) => states[id] === wanted);
    },
    {
      timeoutMs: 20000,
      detail: async () =>
        `intents=${JSON.stringify(concurrentIntents)} stored=${JSON.stringify(await toggleStatesFromApi())} before=${JSON.stringify(beforeConcurrent)}`,
    },
  );

  // A reverted write is exactly "the gateway kept one of the two". Stated
  // separately from the check above so the failure names the defect rather than
  // reporting a generic mismatch.
  const afterConcurrent = await toggleStatesFromApi();
  await expectEveryProvider(
    afterConcurrent,
    concurrentIntents,
    'neither of the two concurrent toggles was reverted',
  );

  // And the rendered switches must agree with what the gateway holds, so a row
  // cannot end up displaying the value its own request asked for while the
  // gateway holds the other.
  const renderedStates = await renderedToggleStates();
  await expectEveryProvider(
    renderedStates,
    afterConcurrent,
    'both rendered switches agree with the gateway after the race',
  );

  // Restore the fixture for the rest of the run, and confirm it took effect rather
  // than assuming it: everything after this point expects both rows enabled.
  await page.evaluate(() => {
    for (const row of Array.from(document.querySelectorAll('.providers-page tbody tr'))) {
      const node = row.querySelector('.ant-switch');
      if (node && node.getAttribute('aria-checked') !== 'true') {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }
  });
  await checkEventually(
    'the concurrent race leaves both fixture providers enabled',
    async () => Object.values(await toggleStatesFromApi()).every(Boolean),
    { timeoutMs: 20000, detail: async () => `stored=${JSON.stringify(await toggleStatesFromApi())}` },
  );

  page.off('request', recordToggleWrite);

  // The suite reuses this app and fake CPA, so the fixture is put back where the
  // rest of the run expects to find it and then confirmed, rather than assumed.
  if ((await providerEnabledFromApi('codex-0')) !== initialEnabled) {
    await providerSwitch.click();
  }
  await checkEventually(
    'the provider row is left enabled for the rest of the run',
    async () => (await providerEnabledFromApi('codex-0')) === initialEnabled,
    { detail: async () => `api=${await providerEnabledFromApi('codex-0')}` },
  );

  // The providers list is read with `include_keys=true`, so its response body
  // carries provider key material. auditPage scans whatever is still buffered in
  // `responseBodies`, and the next audit is for a page whose contract excludes
  // those secrets - so the buffer is cleared here, at the end of the block, where
  // the convention in this module puts it.
  responseBodies.length = 0;
}
