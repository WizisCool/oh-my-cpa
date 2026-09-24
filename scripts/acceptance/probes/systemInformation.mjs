import { until } from '../harness.mjs';

/**
 * The System Information page, and the claim that rendering a release's change log does
 * not reach outside this origin.
 *
 * A release body is untrusted remote Markdown that arrives from GitHub. Two of the
 * promises made about it cannot be checked anywhere below a real engine:
 *
 *   - **No third-party request.** A body may contain `![img](https://tracker.example/x.png)`,
 *     and a renderer that passes images through would make the operator's browser announce
 *     itself to a host named by whoever wrote the release. The probe counts every request
 *     the page issues that is not to its own origin, with an image in the body to catch it.
 *   - **No HTML execution.** A body may contain `<img src=... onerror=...>` or a `<script>`
 *     tag. The promise is that it renders as text, so the probe asserts the element count is
 *     zero and that the literal text survives where a reader can see it.
 *
 * Both are asserted after expanding the change log, because that is when the untrusted text
 * is rendered at all.
 */

/** A release body that exercises every way a renderer could escape its sandbox. */
const hostileBody = [
  '## Changelog',
  '',
  '- ![tracking pixel](https://tracker.example.invalid/pixel.png)',
  '- <img src="https://tracker.example.invalid/html-pixel.png" onerror="window.__omcProbe = 1">',
  '- <script>window.__omcProbe = 2</script>',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
].join('\n');

export function systemFixtures() {
  return [
    [
      (url) => url.pathname.endsWith('/management/system'),
      () => ({
        omc_version: {
          product: 'omc',
          running_version: 'v0.1.0-dev',
          latest_version: 'v0.2.0',
          state: 'indeterminate',
          reason: 'running_version_not_comparable',
          repository: 'WizisCool/oh-my-cpa',
          repository_url: 'https://github.com/WizisCool/oh-my-cpa',
          checked_at_ms: 1790017000000,
          attempted_at_ms: 1790017000000,
          check_error: '',
          checking: false,
          merge_count: 1,
          range_complete: true,
          notes_available: true,
        },
        cpa_version: {
          product: 'cpa',
          running_version: '7.3.5',
          latest_version: 'v7.3.7',
          state: 'update_available',
          repository: 'router-for-me/CLIProxyAPI',
          repository_url: 'https://github.com/router-for-me/CLIProxyAPI',
          checked_at_ms: 1790017000000,
          attempted_at_ms: 1790017000000,
          check_error: '',
          checking: false,
          merge_count: 2,
          range_complete: true,
          notes_available: true,
        },
        uptime_seconds: 3600,
        database: {
          status: 'ok',
          driver: 'sqlite',
          journal_mode: 'wal',
          wal_mode: true,
          synchronous: 1,
          foreign_keys: 1,
          busy_timeout_ms: 5000,
          schema_version: 24,
          page_size: 4096,
          page_count: 4327,
          freelist_count: 12,
          used_bytes: 17723392,
          free_page_bytes: 49152,
          files: {
            main_bytes: 15548416,
            main_exists: true,
            wal_bytes: 10926272,
            wal_exists: true,
            shm_bytes: 32768,
            shm_exists: true,
            total_bytes: 26507456,
          },
        },
        cpa: { status: 'connected', endpoint_masked: 'configured', latency_ms: 42 },
        collector: { status: 'active', mode: 'auto', gap_count: 0 },
        data_volumes: {
          usage_events: 13649,
          error_events: 0,
          inbox_pending: 0,
          first_event_ms: 1758030946322,
          last_event_ms: 1790017069208,
          audit_events: 6,
          credentials: 9,
          providers: 3,
          plugins: 3,
        },
        maintenance: {
          action: '',
          // No job has ever run in the fixture's steady state, which is what job id 0 means.
          job_id: 0,
          running: false,
          started_at_ms: 0,
          finished_at_ms: 0,
          size_before_bytes: 0,
          size_after_bytes: 0,
          reclaimed_bytes: 0,
          incomplete: false,
          detail: '',
          error: '',
        },
        maintenance_admission: {
          action: 'vacuum',
          required_bytes: 31096832,
          available_bytes: 88480247808,
          allowed: true,
          reason: '',
        },
        runtime: {
          go_version: 'go1.24.0',
          os_arch: 'linux/amd64',
          pid: 4242,
          started_at_ms: 1790013000000,
          num_goroutines: 48,
          alloc_mb: 42,
          sys_mb: 96,
          num_gc: 7,
        },
      }),
    ],
    [
      (url) => url.pathname.endsWith('/management/system/releases'),
      () => ({
        product: 'cpa',
        repository: 'router-for-me/CLIProxyAPI',
        repository_url: 'https://github.com/router-for-me/CLIProxyAPI',
        running_version: '7.3.5',
        latest_version: 'v7.3.7',
        state: 'update_available',
        range_complete: true,
        checked_at_ms: 1790017000000,
        attempted_at_ms: 1790017000000,
        check_error: '',
        checking: false,
        releases: [
          {
            tag: 'v7.3.7',
            name: 'v7.3.7',
            published_at_ms: 1790017000000,
            prerelease: false,
            body: hostileBody,
            html_url: 'https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.3.7',
            in_range: true,
            body_available: true,
          },
          {
            tag: 'v7.3.6',
            name: 'v7.3.6',
            published_at_ms: 1790016000000,
            prerelease: false,
            body: '',
            html_url: 'https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.3.6',
            in_range: true,
            body_available: false,
          },
        ],
      }),
    ],
  ];
}

export async function systemInformationPage({ base, page, check }) {
  // Every request the page makes to a host that is not its own origin. Recorded from the
  // first navigation, so a request issued while expanding the log is captured too.
  const offOriginRequests = [];
  // Compared by origin rather than by the console's path prefix: the dev server serves the
  // module graph from `/src/...` and the entry from `/omc/`, so a prefix test would treat the
  // application's own source as a third party.
  const ownOrigin = new URL(base).origin;
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    try {
      if (new URL(url).origin === ownOrigin) return;
    } catch {
      // A URL the parser rejects cannot be a host this page asked for.
      return;
    }
    offOriginRequests.push(url);
  });

  await page.goto(`${base}/system`, { waitUntil: 'domcontentloaded' });
  await page.locator('.system-page').waitFor({ timeout: 20_000 });

  // Page load itself must not reach out: the page checks for updates on mount in a
  // self-hosted deployment, and that call is mocked here, so anything off-origin is a
  // renderer fetching something it should not.
  check(
    'loading the page issues no third-party request',
    offOriginRequests.length === 0,
    offOriginRequests.slice(0, 3).join(' | '),
  );

  // ── the running and published versions are both readable ───────────────────
  // Both readouts come from the system route, so the assertion waits for the read rather
  // than for the panel around it: the panel mounts first, and a loaded machine loses that
  // race often enough to have failed this check intermittently.
  const versionsShown = await until(
    async () => (await page.locator('.system-page').innerText()).includes('7.3.5'),
    { label: 'the running gateway version readout', timeoutMs: 10_000 },
  ).then(() => true).catch(() => false);
  const pageText = await page.locator('.system-page').innerText();
  check('the page states the running gateway version', versionsShown, pageText.slice(0, 200));
  check('the page states the published gateway version', pageText.includes('v7.3.7'));

  // ── the change log renders the untrusted body ──────────────────────────────
  // The toggle is the only control that brings the body into the document.
  const toggle = page.locator('.system-page').getByRole('button', { name: /change log|Change Log|变更日志|日誌/i }).first();
  const hasToggle = (await toggle.count()) === 1;
  check('a change log control is offered for an available update', hasToggle);
  if (!hasToggle) return;

  await toggle.click();
  // The log opens as an overlay, and the body arrives from the releases route, so both the
  // panel and its content are asynchronous.
  const drawer = page.locator('.ant-drawer:visible');
  const drawerShown = await until(async () => ((await drawer.count()) > 0 ? true : false), {
    label: 'the change log drawer',
    timeoutMs: 10_000,
  }).catch(() => false);
  check('the change log opens as an overlay rather than growing the card', drawerShown);
  if (!drawerShown) return;

  const rendered = await until(async () => {
    const tables = await drawer.locator('table').count();
    return tables > 0 ? true : false;
  }, { label: 'the release body', timeoutMs: 10_000 }).catch(() => false);
  check('the release body renders as Markdown', rendered, 'no Markdown table was rendered');

  // ── HTML in the body is never executed and never becomes an element ────────
  // Scoped to the drawer, because that is where the untrusted text is rendered.
  const injectedImages = await drawer.locator('img').count();
  check(
    'an image in a release body is not rendered as an image',
    injectedImages === 0,
    `${injectedImages} <img> element(s) in the page`,
  );
  const scripts = await drawer.locator('script').count();
  check('a script tag in a release body does not become an element', scripts === 0, `${scripts} <script> element(s)`);
  const probeRan = await page.evaluate(() => window.__omcProbe ?? null);
  check('an inline event handler in a release body never runs', probeRan === null, `window.__omcProbe = ${probeRan}`);

  // ── and no host named by the body was contacted ────────────────────────────
  // This is the assertion the image fixture exists for: a renderer that passed `src`
  // through would have fetched the tracker by now.
  const trackerRequests = offOriginRequests.filter((url) => url.includes('tracker.example.invalid'));
  check(
    'expanding the change log contacts no host named in the body',
    trackerRequests.length === 0,
    trackerRequests.join(' | '),
  );
  check(
    'expanding the change log issues no third-party request at all',
    offOriginRequests.length === 0,
    offOriginRequests.slice(0, 3).join(' | '),
  );

  // ── a release without notes names itself instead of rendering an empty box ─
  // The index survives a restart while the notes do not, so this state is normal and
  // must not read as "nothing changed".
  const entries = await drawer.innerText();
  check(
    'a release whose notes are unavailable still names itself',
    entries.includes('v7.3.6'),
    'the note-less release was dropped from the log',
  );

  // Close the log before asserting what the page itself shows.
  await page.keyboard.press('Escape');
  await until(async () => ((await page.locator('.ant-drawer:visible').count()) === 0 ? true : false), {
    label: 'the drawer closing',
    timeoutMs: 5000,
  }).catch(() => {});

  // ── the page stays a gateway dashboard, not a database console ─────────────
  // The page shows four cards: versions, storage, component health, maintenance. A page
  // that grows a fifth surface as a side effect of a later change is the failure this
  // pins, because the information budget is a product decision rather than a default.
  const cardTitles = await page.locator('.system-page .ant-card-head-title').allInnerTexts();
  check(
    'the page keeps its four cards',
    cardTitles.length === 4,
    `found ${cardTitles.length}: ${cardTitles.join(' | ')}`,
  );
  // The DBA details live in the diagnostics bundle, not here.
  const pageTextForScope = await page.locator('.system-page').innerText();
  const leaked = ['Freelist', 'freelist', 'Busy Timeout', 'Synchronous'].filter((needle) =>
    pageTextForScope.includes(needle),
  );
  check('internal database settings are not on the page', leaked.length === 0, leaked.join(', '));

  // ── the card carries no routine "last checked" readout ────────────────────
  // It was the same timestamp on every card and answered a question nobody asked. What must
  // remain is the state a reader cannot infer: that this process holds no release notes.
  const cardText = await page.locator('.system-page').innerText();
  check(
    'the version cards carry no routine last-checked timestamp',
    !/Last checked|上次检查/.test(cardText),
    'a last-checked readout is back on the card',
  );

  // ── the storage card reports measured files, not a rounded total ───────────
  // A missing file and an empty file are different answers, and only the real page can be
  // checked for printing the distinction.
  const storageText = await page.locator('.system-page').innerText();
  check(
    'the storage card reports the measured database files',
    storageText.includes('WAL') || storageText.includes('wal'),
    'no per-file breakdown was rendered',
  );

  const fileRowCount = await page.locator('[data-testid="sys-storage-file-row"]').count();
  check('storage card renders 3 file breakdown rows', fileRowCount === 3, `found ${fileRowCount}`);

  const factRowCount = await page.locator('[data-testid="sys-storage-fact-row"]').count();
  check('storage card renders 3 secondary fact rows', factRowCount === 3, `found ${factRowCount}`);

  // Assert storage card internal row alignment and bounds
  const storageCardLayout = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="sys-card-storage"]');
    if (!card) return { found: false, errors: ['no storage card found'] };

    const cardBox = card.getBoundingClientRect();
    const errors = [];

    const fileRows = Array.from(card.querySelectorAll('[data-testid="sys-storage-file-row"]'));
    for (const row of fileRows) {
      const children = Array.from(row.children);
      if (children.length >= 2) {
        const leftBox = children[0].getBoundingClientRect();
        const rightBox = children[1].getBoundingClientRect();
        if (leftBox.right > rightBox.left + 1) {
          errors.push(`file row label and value overlap: "${children[0].textContent}" over "${children[1].textContent}"`);
        }
        if (rightBox.right > cardBox.right + 2) {
          errors.push(`file row value overflows card: "${children[1].textContent}"`);
        }
      }
    }

    const factRows = Array.from(card.querySelectorAll('[data-testid="sys-storage-fact-row"]'));
    for (const row of factRows) {
      const children = Array.from(row.children);
      if (children.length >= 2) {
        const leftBox = children[0].getBoundingClientRect();
        const rightBox = children[1].getBoundingClientRect();
        if (leftBox.right > rightBox.left + 1) {
          errors.push(`fact row label and value overlap: "${children[0].textContent}" over "${children[1].textContent}"`);
        }
        if (rightBox.right > cardBox.right + 2) {
          errors.push(`fact row value overflows card: "${children[1].textContent}"`);
        }
      }
    }

    return { found: true, errors };
  });

  check(
    'storage card rows have aligned labels and values with no overlap or card overflow',
    storageCardLayout.found && storageCardLayout.errors.length === 0,
    storageCardLayout.errors.join(' | '),
  );

  // ── the retained terminal job is not resurrected by a reload ────────────────
  // The server keeps its last job in process memory for the life of the process, and the page
  // must not present that record as a result the reader can neither dismiss nor escape. The
  // fixture reports a retained terminal job from BOTH reads, because a fixture that only ever
  // returned an empty job could not tell "the page ignores a retained result" from "there was
  // never a retained result".
  const retainedJob = {
    action: 'wal_checkpoint',
    job_id: 1,
    running: false,
    started_at_ms: 1790015000000,
    finished_at_ms: 1790015001200,
    size_before_bytes: 26507456,
    size_after_bytes: 26505000,
    reclaimed_bytes: 2456,
    incomplete: false,
    detail: 'write-ahead log frames 0, checkpointed 0',
    error: '',
  };
  // The base body comes from the same fixture table the rest of the scenario uses, so this route
  // changes one field instead of restating the whole response. It is NOT read back over the
  // network: `route.fetch()` would leave the harness's own mock and hit the dev server, which
  // answers no API and takes the session with it.
  const systemInfoFixture = systemFixtures()
    .find(([matches]) => matches(new URL('http://probe/omc/api/v1/management/system')));
  const baseSystemBody = () => systemInfoFixture[1]();
  // What `/management/system` reports as the last job. It is a variable because the scenario
  // needs three states from one page: a retained terminal job, a job that is still running when
  // the page opens, and a job this page itself started.
  let servedMaintenance = retainedJob;
  // The backend process the fixture reports. It is a variable because a restart mints job ids from
  // the beginning again, which is the case the page has to survive without a reload.
  let servedProcessStart = 1790013000000;
  await page.route('**/omc/api/v1/management/system', async (route) => {
    const body = baseSystemBody();
    body.runtime = { ...body.runtime, started_at_ms: servedProcessStart };
    await route.fulfill({ status: 200, json: { ...body, maintenance: servedMaintenance } });
  });

  // The retained job must actually be what the page is being offered, or the assertion below
  // would pass on a fixture that quietly served nothing.
  const servedRetained = await page.evaluate(async () => {
    const res = await fetch('/omc/api/v1/management/system', { headers: { Accept: 'application/json' } });
    return (await res.json()).maintenance?.action ?? '';
  });
  check('the fixture serves a retained terminal job', servedRetained === 'wal_checkpoint', `action=${servedRetained}`);

  // Started before the navigation it belongs to, so the response cannot be missed by a race.
  const reloadedSystemRead = page.waitForResponse(
    (res) => res.request().method() === 'GET' && new URL(res.url()).pathname.endsWith('/management/system'),
    { timeout: 20_000 },
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.system-page').waitFor({ timeout: 20_000 });
  // The assertion below is a *negative* one, and a negative assertion against a page that has not
  // read its data yet reports zero for the wrong reason. So the page's own read of the retained
  // job is awaited, and then the card is awaited rendering it. Neither wait is swallowed: a page
  // that never settles must fail here rather than let this check pass on an empty page.
  await reloadedSystemRead;
  await until(
    async () =>
      (await page.locator('[data-testid="sys-storage-file-row"]').count()) === 3 &&
      (await page.locator('[data-testid="sys-card-maintenance"] .ant-btn').count()) > 0,
    { label: 'the reloaded page rendering the response that carries the retained job', timeoutMs: 15_000 },
  );

  const retainedOutcomeCount = await page.locator('[data-testid="sys-maintenance-outcome"]').count();
  check(
    'a retained terminal job is not shown as this page\'s result',
    retainedOutcomeCount === 0,
    `${retainedOutcomeCount} outcome panel(s)`,
  );

  // ── a job already running when the page opens is followed to its outcome ────
  // The other half of the rule: a retained record is ignored, but a job that is genuinely in
  // flight must be adopted and reported, or the page would silently hide real work.
  const runningOnLoad = {
    action: 'wal_checkpoint',
    job_id: 2,
    running: true,
    started_at_ms: 1790018000000,
    finished_at_ms: 0,
    size_before_bytes: 26507456,
    size_after_bytes: 0,
    reclaimed_bytes: 0,
    incomplete: false,
    detail: '',
    error: '',
  };
  servedMaintenance = runningOnLoad;
  // The job is reported as running for its first two reads and terminal afterwards, so the reader
  // has a window in which the in-progress banner is genuinely on screen. A mock that finished the
  // job on the first read would make the banner assertion a race rather than a measurement.
  let runningOnLoadPolls = 0;
  const runningOnLoadHandler = async (route) => {
    runningOnLoadPolls += 1;
    const stillRunning = runningOnLoadPolls <= 2;
    if (!stillRunning) {
      // One server holds one job status, so `/management/system` is moved to the same terminal
      // record. A fixture that left it reporting the job as running would describe a deployment
      // that cannot exist, and the page would be right to keep showing it as in progress.
      runningOnLoad.running = false;
      runningOnLoad.finished_at_ms = 1790018003000;
      runningOnLoad.size_after_bytes = 26505000;
      runningOnLoad.reclaimed_bytes = 2456;
      runningOnLoad.detail = 'write-ahead log frames 0, checkpointed 0';
      servedMaintenance = { ...runningOnLoad };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        maintenance: servedMaintenance,
        maintenance_admission: { action: 'wal_checkpoint', required_bytes: 0, available_bytes: 5_000_000, allowed: true, reason: '' },
      }),
    });
  };
  await page.route('**/omc/api/v1/management/system/maintenance**', runningOnLoadHandler);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.system-page').waitFor({ timeout: 20_000 });
  // The in-progress banner is the reader's evidence that a job is holding the write gate, so it
  // must appear for a job this page never started. Scoped to the info alert rather than the card's
  // whole text: the card's static copy also contains words this check greps for, so measuring the
  // card as a whole could report a banner that was never rendered.
  const runningAlert = page.locator('[data-testid="sys-card-maintenance"] .ant-alert-info');
  const bannerShown = await until(
    async () => (await runningAlert.count()) > 0,
    { label: 'the in-progress banner for a job already running', timeoutMs: 15_000 },
  ).catch(() => false);
  const bannerText = (await runningAlert.first().innerText().catch(() => '')) || '';
  check(
    'a job already running when the page opens is shown as in progress',
    Boolean(bannerShown) && /checkpoint|回收/i.test(bannerText),
    `banner=${Boolean(bannerShown)} alert=${bannerText.slice(0, 120)}`,
  );

  await until(
    async () => (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) > 0,
    { label: 'the adopted job\'s outcome', timeoutMs: 15_000 },
  ).catch(() => {});
  const adoptedOutcome = await page.locator('[data-testid="sys-maintenance-outcome"]').innerText().catch(() => '');
  // The reclaimed figure is the point of the panel: it is the number the reader ran the job to see,
  // and it can only come from the job this page adopted.
  check(
    'the adopted job\'s outcome is reported when it finishes',
    /2\.4\d*\s*KB/i.test(adoptedOutcome.replace(/\s+/g, ' ')) && /reclaimed|净回收/i.test(adoptedOutcome),
    `outcome text: ${adoptedOutcome.slice(0, 160)}`,
  );
  await page.unroute('**/omc/api/v1/management/system/maintenance**', runningOnLoadHandler);

  // ── a job superseded by a newer one is still reported ───────────────────────
  // The server holds one job status, so a fast job that finishes and is replaced inside a single
  // poll interval means no poll ever reports the replacement as running - the first sign of it is
  // its terminal record. A page that accepted only the exact job it was following dropped that
  // result and kept polling for a job that had already been replaced.
  const watchedJob = {
    action: 'wal_checkpoint',
    job_id: 3,
    running: true,
    started_at_ms: 1790050000000,
    finished_at_ms: 0,
    size_before_bytes: 9_000_000,
    size_after_bytes: 0,
    reclaimed_bytes: 0,
    incomplete: false,
    detail: '',
    error: '',
  };
  const supersedingJob = {
    action: 'wal_checkpoint',
    // A later id, which is what makes it the replacement rather than a stale record - and the start
    // time is deliberately EARLIER than the watched job's, which is what a clock stepping backwards
    // under time synchronisation produces. Ordering by that timestamp would call this record stale
    // and drop its result; the id says what it is.
    job_id: 4,
    running: false,
    started_at_ms: 1790049999000,
    finished_at_ms: 1790050011000,
    size_before_bytes: 9_000_000,
    size_after_bytes: 8_999_000,
    reclaimed_bytes: 1000,
    incomplete: false,
    detail: 'the replacement job',
    error: '',
  };
  servedMaintenance = { ...watchedJob };
  let supersedePolls = 0;
  const supersedeHandler = async (route) => {
    supersedePolls += 1;
    const job = supersedePolls === 1 ? watchedJob : supersedingJob;
    servedMaintenance = { ...job };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        maintenance: job,
        maintenance_admission: { action: 'wal_checkpoint', required_bytes: 0, available_bytes: 5_000_000, allowed: true, reason: '' },
      }),
    });
  };
  await page.route('**/omc/api/v1/management/system/maintenance**', supersedeHandler);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.system-page').waitFor({ timeout: 20_000 });
  await until(
    async () => (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) > 0,
    { label: 'the superseding job\'s outcome', timeoutMs: 15_000 },
  ).catch(() => {});
  const supersededOutcome = await page.locator('[data-testid="sys-maintenance-outcome"]').innerText().catch(() => '');
  check(
    'a job superseded by a newer one is reported rather than dropped',
    supersededOutcome.includes('the replacement job'),
    `polls=${supersedePolls} outcome text: ${supersededOutcome.slice(0, 160)}`,
  );
  await page.unroute('**/omc/api/v1/management/system/maintenance**', supersedeHandler);

  // ── a job that starts AFTER the page is open is followed to its outcome ─────
  // A job admitted elsewhere - another tab, another operator - is invisible to the page until a
  // refetch reports it, and the page's own read is how it learns. This is the case an adoption
  // path that only looks at the first response would miss: the reader sees the in-progress banner
  // and then nothing, because no poll was ever started for it.
  await page.locator('[data-testid="sys-maintenance-outcome"]').getByRole('button', { name: /Close|关闭/i }).first().click().catch(() => {});
  const laterJobPolls = [];
  const laterJob = {
    action: 'vacuum',
    job_id: 5,
    running: true,
    started_at_ms: 1790030000000,
    finished_at_ms: 0,
    size_before_bytes: 26507456,
    size_after_bytes: 0,
    reclaimed_bytes: 0,
    incomplete: false,
    detail: '',
    error: '',
  };
  let laterPollCount = 0;
  const laterJobHandler = async (route) => {
    laterPollCount += 1;
    laterJobPolls.push(laterPollCount);
    // The job is reported running for its first two reads and terminal afterwards, and
    // `/management/system` is moved with it: one server holds one job status, so a fixture that
    // left that read reporting a finished job would describe a deployment that cannot exist.
    const stillRunning = laterPollCount <= 2;
    if (!stillRunning) {
      laterJob.running = false;
      laterJob.finished_at_ms = 1790030005000;
      laterJob.size_after_bytes = 26505456;
      laterJob.reclaimed_bytes = 2000;
      laterJob.detail = 'rebuilt under an exclusive lock';
    }
    servedMaintenance = { ...laterJob };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        maintenance: servedMaintenance,
        maintenance_admission: { action: 'vacuum', required_bytes: 2000, available_bytes: 5_000_000, allowed: true, reason: '' },
      }),
    });
  };
  // The page is idle with no job; the job begins now, on the server, and only a refetch reveals it.
  servedMaintenance = { action: '', job_id: 0, running: false, started_at_ms: 0, finished_at_ms: 0, size_before_bytes: 0, size_after_bytes: 0, reclaimed_bytes: 0, incomplete: false, detail: '', error: '' };
  await page.route('**/omc/api/v1/management/system/maintenance**', laterJobHandler);
  servedMaintenance = { ...laterJob };
  // Refresh re-reads both endpoints, which is how this page learns about the job it never started.
  await page.locator('.system-page').getByRole('button', { name: /Refresh|刷新/i }).first().click();

  await until(
    async () => (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) > 0,
    { label: 'the outcome of a job discovered after page load', timeoutMs: 15_000 },
  ).catch(() => {});
  check(
    'a job discovered after the page is open is polled to its outcome',
    laterJobPolls.length > 0,
    `${laterJobPolls.length} poll(s)`,
  );
  const laterOutcome = await page.locator('[data-testid="sys-maintenance-outcome"]').innerText().catch(() => '');
  check(
    'the discovered job\'s outcome names its own action and reclaimed bytes',
    /vacuum|重建/i.test(laterOutcome) && /1\.9\d*\s*KB/i.test(laterOutcome.replace(/\s+/g, ' ')),
    `outcome text: ${laterOutcome.slice(0, 160)}`,
  );
  await page.unroute('**/omc/api/v1/management/system/maintenance**', laterJobHandler);

  // ── a running job is shown even when the poll cache is stale ───────────────
  // The card reads the poll's cache while polling is enabled, and that cache can still hold an
  // earlier job's terminal record - the previous block leaves exactly that behind. A page that
  // showed that record instead of the job it had just adopted hid real work: no in-progress
  // banner, and maintenance controls that looked idle while a job held the write gate.
  const freshRunningJob = {
    action: 'wal_checkpoint',
    job_id: 6,
    running: true,
    started_at_ms: 1790060000000,
    finished_at_ms: 0,
    size_before_bytes: 9_000_000,
    size_after_bytes: 0,
    reclaimed_bytes: 0,
    incomplete: false,
    detail: '',
    error: '',
  };
  // A poll that is deliberately slow. The window before it answers is the one that matters: while
  // polling is enabled the card reads the poll's cache, so only a seeded cache can report the
  // running job then. Only the first poll is slow; every later one reports the job finished, so the
  // page settles and the checks after this block see an idle card.
  let slowPolls = 0;
  const slowPollHandler = async (route) => {
    slowPolls += 1;
    if (slowPolls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          maintenance: freshRunningJob,
          maintenance_admission: { action: 'wal_checkpoint', required_bytes: 0, available_bytes: 5_000_000, allowed: true, reason: '' },
        }),
      });
      return;
    }
    const finishedJob = {
      ...freshRunningJob,
      running: false,
      finished_at_ms: 1790060005000,
      size_after_bytes: 8_999_900,
      reclaimed_bytes: 100,
    };
    servedMaintenance = { ...finishedJob };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        maintenance: finishedJob,
        maintenance_admission: { action: 'wal_checkpoint', required_bytes: 0, available_bytes: 5_000_000, allowed: true, reason: '' },
      }),
    });
  };
  await page.route('**/omc/api/v1/management/system/maintenance**', slowPollHandler);
  servedMaintenance = { ...freshRunningJob };
  await page.locator('.system-page').getByRole('button', { name: /Refresh|刷新/i }).first().click();

  // Measured inside the window before the slow poll answers. The window is the point: with no
  // seeded cache the card reads the earlier job's terminal record, so the banner appears only once
  // that poll lands - some ten seconds later - and a wait that tolerated that would prove nothing.
  // Scoped to the info alert rather than the card's whole text, for the same reason as the assertion
  // above: the card's static copy contains words this check would otherwise match, so measuring the
  // card as a whole could report a banner that was never rendered.
  const staleCacheAlert = page.locator('[data-testid="sys-card-maintenance"] .ant-alert-info');
  const runningBannerShown = await until(
    async () => (await staleCacheAlert.count()) > 0,
    { label: 'the in-progress banner for a job the page just adopted', timeoutMs: 3000 },
  ).catch(() => false);
  check(
    'a running job is shown as in progress even though the poll cache held a terminal record',
    Boolean(runningBannerShown),
    `alert=${(await staleCacheAlert.first().innerText().catch(() => '')).slice(0, 120)}`,
  );
  // The write gate is the reason the banner matters: while a job runs, the actions must not look
  // available. A stale record made them clickable.
  const vacuumDisabledWhileRunning = await page
    .locator('[data-testid="sys-card-maintenance"]')
    .getByRole('button', { name: /VACUUM|重建/i })
    .first()
    .isDisabled()
    .catch(() => false);
  check(
    'maintenance actions are disabled while that job runs',
    vacuumDisabledWhileRunning,
    `VACUUM disabled=${vacuumDisabledWhileRunning}`,
  );
  // Let the delayed job finish, which is what settles this block: the poll stops and the card goes
  // back to idle for the checks that follow.
  await until(
    async () => (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) > 0,
    { label: 'the slow job reaching its outcome', timeoutMs: 30_000 },
  ).catch(() => {});
  check(
    'the job behind the slow poll is still followed to its outcome',
    (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) === 1,
  );
  await page.unroute('**/omc/api/v1/management/system/maintenance**', slowPollHandler);

  // ── a backend restart does not make the new process's job look handled ──────
  // Job ids come from a counter that starts again with each process, so a restart can mint an id
  // this page has already seen. Nothing here reloads the page: a reload would reset the page's own
  // state and hide the very confusion being tested - the page must notice the process changed and
  // treat the new process's job as new work.
  const postRestartJob = {
    action: 'wal_checkpoint',
    // Deliberately the id the page has just finished reporting - the slow-poll job's, which is the
    // most recent one at this point. A restarted process handing out its ids from one again can
    // collide exactly like this, and a page that compared ids alone would treat the new job as one
    // it had already dealt with.
    job_id: 6,
    running: true,
    started_at_ms: 1790070000000,
    finished_at_ms: 0,
    size_before_bytes: 9_000_000,
    size_after_bytes: 0,
    reclaimed_bytes: 0,
    incomplete: false,
    detail: '',
    error: '',
  };
  let postRestartPolls = 0;
  const postRestartHandler = async (route) => {
    postRestartPolls += 1;
    const running = postRestartPolls <= 2;
    const job = running
      ? postRestartJob
      : {
          ...postRestartJob,
          running: false,
          finished_at_ms: 1790070003000,
          size_after_bytes: 8_998_000,
          reclaimed_bytes: 2000,
          detail: 'the job the restarted process ran',
        };
    servedMaintenance = { ...job };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        maintenance: job,
        maintenance_admission: { action: 'wal_checkpoint', required_bytes: 0, available_bytes: 5_000_000, allowed: true, reason: '' },
      }),
    });
  };
  await page.route('**/omc/api/v1/management/system/maintenance**', postRestartHandler);
  // The process restarts: a new start instant, and the job it admits reuses an id.
  servedProcessStart = 1790070000000;
  servedMaintenance = { ...postRestartJob };
  await page.locator('.system-page').getByRole('button', { name: /Refresh|刷新/i }).first().click();

  await until(
    async () => (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) > 0,
    { label: 'the restarted process\'s job outcome', timeoutMs: 15_000 },
  ).catch(() => {});
  const postRestartOutcome = await page.locator('[data-testid="sys-maintenance-outcome"]').innerText().catch(() => '');
  check(
    'a job from a restarted process is reported even though its id was used before',
    postRestartOutcome.includes('the job the restarted process ran'),
    `polls=${postRestartPolls} outcome text: ${postRestartOutcome.slice(0, 160)}`,
  );
  await page.unroute('**/omc/api/v1/management/system/maintenance**', postRestartHandler);

  // ── a maintenance job is admitted as started, and its outcome is its own ────
  // 202 means accepted, not done. The page must say so when it is accepted and report the
  // real result afterwards, including the partial outcome SQLite reports in-band: a
  // checkpoint blocked by a reader raises no error and must not be shown as success.
  //
  // The mock is stateful and reports ONE job identity across every read, which is what the
  // server does (the action, the job id and the start instant are all fixed when the job is
  // reserved). The identity rule it exercises is direction-aware: a record whose job id is
  // *higher* than the observed job's is accepted as superseding it, while a lower one is refused
  // as the stale record. The id is what is compared, not the timestamp, because the server assigns
  // it from a counter: two jobs can start in the same millisecond and a synchronised clock can
  // step backwards, either of which would make a later job look like one already handled.
  const acceptedJob = {
    action: 'vacuum',
    job_id: 7,
    running: true,
    started_at_ms: 0,
    finished_at_ms: 0,
    size_before_bytes: 1000,
    size_after_bytes: 0,
    reclaimed_bytes: 0,
    incomplete: false,
    detail: '',
    error: '',
  };
  const admission = { action: 'vacuum', required_bytes: 2000, available_bytes: 5_000_000, allowed: true, reason: '' };
  // The first GET after the POST reports the job still running, and every later one reports the
  // partial outcome: the page has to follow the job across both, rather than read once.
  let pollCount = 0;
  await page.route('**/omc/api/v1/management/system/maintenance**', async (route) => {
    if (route.request().method() === 'POST') {
      acceptedJob.started_at_ms = 1790020000000;
      // The page's own read is moved with the job. One server holds one job status, so a fixture
      // that left `/management/system` reporting the previous job while the poll reported this one
      // would describe a deployment that cannot exist - and it would let the refresh assertion
      // below pass against a server that never agreed with the job the page was following.
      servedMaintenance = { ...acceptedJob };
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ maintenance: acceptedJob, maintenance_admission: admission }),
      });
      return;
    }
    pollCount += 1;
    const running = pollCount === 1;
    const job = running
      ? acceptedJob
      : {
          ...acceptedJob,
          running: false,
          finished_at_ms: 1790020004000,
          size_after_bytes: 600,
          reclaimed_bytes: 400,
          incomplete: true,
          detail: 'blocked by a concurrent reader',
        };
    servedMaintenance = { ...job };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ maintenance: job, maintenance_admission: admission }),
    });
  });

  const vacuumButton = page.locator('.system-page').getByRole('button', { name: /VACUUM|重建/i }).first();
  if ((await vacuumButton.count()) === 1 && (await vacuumButton.isEnabled())) {
    await vacuumButton.click();
    // The confirmation states the measured requirement before anything runs.
    const dialog = page.locator('.ant-modal:visible');
    const dialogShown = await until(async () => ((await dialog.count()) > 0 ? true : false), {
      label: 'the confirmation',
      timeoutMs: 5000,
    }).catch(() => false);
    check('the rebuild asks for confirmation first', dialogShown);

    if (dialogShown) {
      const confirm = dialog.getByRole('button', { name: /^(Confirm|OK|确定)$/ }).first();
      await confirm.click();
      // A partial outcome must not be announced as success.
      const warned = await until(async () => {
        const warning = page.locator('.ant-message-warning, .ant-message-error');
        return (await warning.count()) > 0 ? true : false;
      }, { label: 'the outcome notice', timeoutMs: 8000 }).catch(() => false);
      check('an incomplete rebuild is reported as partial, not as success', warned);

      // ── the observed job's result is shown, and clearing it is permanent ────
      // The panel is the page's own record of a job it watched, so it appears for this job and
      // stays clear once dismissed - a refetch must not bring it back.
      await until(
        async () => (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) > 0,
        { label: 'the observed outcome panel', timeoutMs: 10_000 },
      ).catch(() => {});
      check(
        'an observed job\'s result is shown',
        (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) === 1,
      );
      check(
        'the observed result is classified as incomplete, not successful',
        (await page.locator('[data-testid="sys-maintenance-outcome"]').innerText()).includes('blocked by a concurrent reader'),
      );

      const closeOutcome = page.locator('[data-testid="sys-maintenance-outcome"]').getByRole('button', { name: /Close|关闭/i }).first();
      if ((await closeOutcome.count()) === 1) {
        await closeOutcome.click();
        await until(
          async () => (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) === 0,
          { label: 'the outcome panel closing', timeoutMs: 5000 },
        ).catch(() => {});
        check(
          'the observed result can be cleared',
          (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) === 0,
        );

        // The Refresh control re-reads the server's retained record; a cleared result must not
        // come back through it, which is the defect the reader reported.
        await page.locator('.system-page').getByRole('button', { name: /Refresh|刷新/i }).first().click();
        await page.waitForTimeout(1500);
        check(
          'a cleared result stays cleared across a refresh',
          (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) === 0,
          `${await page.locator('[data-testid="sys-maintenance-outcome"]').count()} outcome panel(s)`,
        );

        // ── and across a reading-language change ──────────────────────────────
        // The terminal effect names `t` among its dependencies, so changing the interface language
        // re-runs it while the terminal record is still in the query cache. A guard placed after
        // the outcome is set would put the dismissed panel back, which reads as the result having
        // restored itself. The language control is the console's own header menu, so this drives
        // the same path a reader does rather than calling internals.
        const beforeSwitch = await page.locator('[data-testid="sys-card-maintenance"]').innerText();
        await page.locator('.language-trigger-code').first().click();
        const languageItem = page
          .locator('.ant-dropdown:visible .ant-dropdown-menu-item')
          .filter({ hasText: '简体中文' })
          .first();
        if ((await languageItem.count()) === 1) {
          await languageItem.click();
          // Awaited rather than slept on: the card's own text is the evidence that the new catalog
          // actually took effect, which is what makes the effect re-run this check is about.
          await until(
            async () => (await page.locator('[data-testid="sys-card-maintenance"]').innerText()) !== beforeSwitch,
            { label: 'the interface language changing', timeoutMs: 10_000 },
          );
          check(
            'a cleared result stays cleared across a language change',
            (await page.locator('[data-testid="sys-maintenance-outcome"]').count()) === 0,
            `${await page.locator('[data-testid="sys-maintenance-outcome"]').count()} outcome panel(s)`,
          );
        } else {
          check('the language menu offers a second reading', false, 'no 简体中文 item in the header menu');
        }
      } else {
        check('the observed result carries a close control', false, 'no close button on the outcome panel');
      }
    }
  } else {
    check('a rebuild control is offered when admission allows it', false, 'no enabled VACUUM button');
  }

  // ── 2x2 grid layout and equal height within rows on desktop ───────────────
  // The four cards form a 2x2 grid where siblings in the same row share equal height.
  // Row 1: Versions & Updates (left) | SQLite Storage (right)
  // Row 2: Component Topology & Health (left) | Maintenance & Diagnostics (right)
  const gridGeometry = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.system-page .ant-card'));
    if (cards.length !== 4) return { error: `expected 4 cards, found ${cards.length}` };

    const boxes = cards.map((c) => {
      const r = c.getBoundingClientRect();
      const title = c.querySelector('.ant-card-head-title')?.textContent?.trim() || '';
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height), title };
    });

    const [c1, c2, c3, c4] = boxes;
    // Row 1 cards (c1, c2) should share top and bottom edge (equal height within row).
    const row1TopDiff = Math.abs(c1.top - c2.top);
    const row1BottomDiff = Math.abs(c1.bottom - c2.bottom);
    const row1HeightDiff = Math.abs(c1.height - c2.height);

    // Row 2 cards (c3, c4) should share top and bottom edge (equal height within row).
    const row2TopDiff = Math.abs(c3.top - c4.top);
    const row2BottomDiff = Math.abs(c3.bottom - c4.bottom);
    const row2HeightDiff = Math.abs(c3.height - c4.height);

    // Column alignment: c1 and c3 on left column, c2 and c4 on right column.
    const colLeftDiff = Math.abs(c1.left - c3.left);
    const colRightDiff = Math.abs(c2.left - c4.left);
    const widthDiff = Math.abs(c1.width - c2.width);

    // Maintenance card must be at bottom right (c4).
    const isMaintenanceFourth = /Maintenance|Penyelenggaraan|维护|維護/i.test(c4.title);

    return {
      row1TopDiff,
      row1BottomDiff,
      row1HeightDiff,
      row2TopDiff,
      row2BottomDiff,
      row2HeightDiff,
      colLeftDiff,
      colRightDiff,
      widthDiff,
      isMaintenanceFourth,
      boxes,
    };
  });

  check(
    'desktop cards in row 1 are equal height and aligned',
    gridGeometry.row1TopDiff <= 2 && gridGeometry.row1BottomDiff <= 2,
    `row1: topDiff=${gridGeometry.row1TopDiff}px, bottomDiff=${gridGeometry.row1BottomDiff}px`,
  );
  check(
    'desktop cards in row 2 are equal height and aligned',
    gridGeometry.row2TopDiff <= 2 && gridGeometry.row2BottomDiff <= 2,
    `row2: topDiff=${gridGeometry.row2TopDiff}px, bottomDiff=${gridGeometry.row2BottomDiff}px`,
  );
  check(
    'desktop columns have equal widths and matching left edges',
    gridGeometry.colLeftDiff <= 2 && gridGeometry.colRightDiff <= 2 && gridGeometry.widthDiff <= 2,
    `colLeftDiff=${gridGeometry.colLeftDiff}px, colRightDiff=${gridGeometry.colRightDiff}px, widthDiff=${gridGeometry.widthDiff}px`,
  );
  check(
    'maintenance card sits in the bottom-right cell',
    gridGeometry.isMaintenanceFourth,
    `fourth card title: ${gridGeometry.boxes?.[3]?.title}`,
  );
}


/**
 * The same page on a 320px screen, where two side-by-side rows did not fit and drew on top of
 * each other instead.
 *
 * The reason this is a separate scenario rather than an assertion inside the one above: the
 * defect is invisible at any wider viewport, and it is invisible to a width check even here.
 * Two elements can each fit the viewport while overlapping one another, so the assertion
 * compares their boxes.
 */
export async function systemInformationNarrow({ base, page, check }) {
  // Malay, not the probe default of English, and not because of translation: Malay renders a
  // noun phrase as one long compound, so it produces the longest strings of any registered
  // catalog. Those are what pushed two side-by-side rows into each other at 320px, and a probe
  // in English could not have seen it - the layout was clean in the language it was built in.
  // The page is read in all four languages by real operators, so the narrow case is measured
  // in the hardest one.
  await page.addInitScript(() => window.localStorage.setItem('omc-lang', 'ms'));
  await page.goto(`${base}/system`, { waitUntil: 'domcontentloaded' });
  await page.locator('.system-page').waitFor({ timeout: 20_000 });

  // F7: the Malay catalog must actually be in force. The preference is stored, but a catalog
  // that failed to load leaves the console reading its default language and the geometry checks
  // would then measure Simplified Chinese while believing they measured the longest strings.
  const documentLocale = await page.evaluate(() => document.documentElement.lang);
  check(
    'the narrow probe renders the Malay catalog',
    documentLocale === 'ms-MY',
    `documentElement.lang=${documentLocale}`,
  );

  // Wait for the product and version rows the measurement depends on, and for the initial update
  // check to finish, rather than sleeping and hoping. A card count alone proves only that four
  // empty containers exist.
  //
  // The timeout is not swallowed: a layout that never settles should fail here rather than let
  // the geometry assertions measure an empty page and pass.
  await until(
    async () =>
      (await page.locator('[data-testid="sys-product-header"]').count()) >= 2 &&
      (await page.locator('[data-testid="sys-version-row"]').count()) >= 2 &&
      (await page.locator('.system-page .ant-btn-loading').count()) === 0,
    { label: 'the settled system version layout', timeoutMs: 15_000 },
  );

  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const overlapping = [];
    // Only rows that place siblings side by side are compared. Comparing every pair of
    // elements would flag each parent against its own child.
    // Selected by test attribute rather than by class: a CSS-module class name is hashed at
    // build time, so a selector naming one matches nothing and the whole probe passes on an
    // empty set. That is how this check was initially vacuous.
    const rows = document.querySelectorAll(
      '[data-testid="sys-card-head"], [data-testid="sys-product-header"], [data-testid="sys-version-row"], [data-testid="sys-storage-file-row"], [data-testid="sys-storage-fact-row"]',
    );
    const collapsed = [];
    for (const row of rows) {
      // Every child that carries text must keep a width. A side-by-side row that runs out of
      // space squeezes one child to nothing rather than overlapping it, and a collapsed element
      // is invisible while still being in the document - so a detector that only compares
      // non-zero widths reports such a row as clean. That is exactly how this probe first
      // missed the defect it was written for.
      for (const child of row.children) {
        const text = (child.textContent || '').trim();
        const box = child.getBoundingClientRect();
        if (text.length > 0 && box.width < 8) {
          collapsed.push(`${row.className}: "${text.slice(0, 24)}" is ${Math.round(box.width)}px wide`);
        }
      }
      const children = [...row.children].filter((el) => el.getBoundingClientRect().width > 0);
      for (let first = 0; first < children.length; first += 1) {
        for (let second = first + 1; second < children.length; second += 1) {
          const a = children[first].getBoundingClientRect();
          const b = children[second].getBoundingClientRect();
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          // A few pixels of contact is ordinary spacing; real overlap is generous.
          if (overlapX > 4 && overlapY > 4) {
            overlapping.push(
              `${row.className}: "${(children[first].textContent || '').trim().slice(0, 20)}" over "${(children[second].textContent || '').trim().slice(0, 20)}"`,
            );
          }
        }
      }
    }
    return {
      overlapping: overlapping.slice(0, 3),
      collapsed: collapsed.slice(0, 3),
      measuredRows: rows.length,
      scrolls: doc.scrollWidth > doc.clientWidth + 1,
      cards: document.querySelectorAll('.system-page .ant-card').length,
    };
  });

  check(
    'no card head or product row draws over its own content at 320px',
    result.overlapping.length === 0,
    result.overlapping.join(' | '),
  );
  // A selector that matches nothing would make the check above vacuous, which is the failure
  // mode this assertion exists to prevent: the probe must be measuring real rows.
  check(
    'the narrow probe measured real side-by-side rows',
    result.measuredRows > 0,
    `matched ${result.measuredRows} rows`,
  );
  check(
    'no row squeezes one of its children down to nothing at 320px',
    result.collapsed.length === 0,
    result.collapsed.join(' | '),
  );
  check('the page does not scroll sideways at 320px', !result.scrolls);
  check('every card still renders at 320px', result.cards === 4, `${result.cards} cards`);

  // Mobile stacking: on 320px narrow screens, cards should stack vertically in a single column
  // where each card starts strictly below the previous one.
  const mobileStacking = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.system-page .ant-card'));
    const boxes = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
    });
    const correctlyStacked = boxes.every((box, i) => {
      if (i === 0) return true;
      return box.top >= boxes[i - 1].bottom - 1;
    });
    return { correctlyStacked, boxes };
  });

  check(
    'cards stack vertically in a single column at 320px',
    mobileStacking.correctlyStacked,
    `boxes: ${JSON.stringify(mobileStacking.boxes)}`,
  );

  // ── Intermediate viewport (800px): below 900px breakpoint, single column ──
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.waitForTimeout(100);

  const intermediateResult = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.system-page .ant-card'));
    const boxes = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
    });
    const correctlyStacked = boxes.every((box, i) => {
      if (i === 0) return true;
      return box.top >= boxes[i - 1].bottom - 1;
    });
    const scrolls = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    return { correctlyStacked, scrolls, boxes };
  });

  check(
    'cards stack vertically in a single column at 800px (below 900px breakpoint)',
    intermediateResult.correctlyStacked,
    `boxes: ${JSON.stringify(intermediateResult.boxes)}`,
  );
  check('the page does not scroll sideways at 800px', !intermediateResult.scrolls);
}

