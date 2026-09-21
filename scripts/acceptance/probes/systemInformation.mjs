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
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) return;
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
  const pageText = await page.locator('.system-page').innerText();
  check('the page states the running gateway version', pageText.includes('7.3.5'), pageText.slice(0, 200));
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

  // ── a maintenance job is admitted as started, and its outcome is its own ────
  // 202 means accepted, not done. The page must say so when it is accepted and report the
  // real result afterwards, including the partial outcome SQLite reports in-band: a
  // checkpoint blocked by a reader raises no error and must not be shown as success.
  await page.route('**/omc/api/v1/management/system/maintenance**', async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          maintenance: { action: 'vacuum', running: true, started_at_ms: Date.now(), finished_at_ms: 0, size_before_bytes: 1000, size_after_bytes: 0, reclaimed_bytes: 0, incomplete: false, detail: '', error: '' },
          maintenance_admission: { action: 'vacuum', required_bytes: 2000, available_bytes: 5_000_000, allowed: true, reason: '' },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        maintenance: { action: 'vacuum', running: false, started_at_ms: Date.now() - 5000, finished_at_ms: Date.now(), size_before_bytes: 1000, size_after_bytes: 600, reclaimed_bytes: 400, incomplete: true, detail: 'blocked by a concurrent reader', error: '' },
        maintenance_admission: { action: 'vacuum', required_bytes: 2000, available_bytes: 5_000_000, allowed: true, reason: '' },
      }),
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
    }
  } else {
    check('a rebuild control is offered when admission allows it', false, 'no enabled VACUUM button');
  }
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
  // Let the version check and its rendering settle before measuring.
  await page.waitForTimeout(1500);

  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const overlapping = [];
    // Only rows that place siblings side by side are compared. Comparing every pair of
    // elements would flag each parent against its own child.
    // Selected by test attribute rather than by class: a CSS-module class name is hashed at
    // build time, so a selector naming one matches nothing and the whole probe passes on an
    // empty set. That is how this check was initially vacuous.
    const rows = document.querySelectorAll(
      '[data-testid="sys-card-head"], [data-testid="sys-product-header"], [data-testid="sys-version-row"]',
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
}
