import { until } from '../harness.mjs';
import { configSourceFixtures } from './configSourceEditor.mjs';

/**
 * The configuration backup dialog: its list, its retention, and a restore.
 *
 * The restore is confirmed in a popover raised from a row inside a modal, so the claim
 * worth a browser is that the confirmation stacks above the dialog and takes the click,
 * and that the write it sends is followed by the editor reloading the document CPA now
 * holds. The list's reason labels and the pre-v8 row's withheld restore are read on the
 * way.
 */

const BACKUPS = {
  backups: [
    { id: 3, created_at_ms: 1767225600000, revision: 'rev-c', size_bytes: 2048, layout: 'v8', reason: 'provider_keys' },
    { id: 2, created_at_ms: 1767222000000, revision: 'rev-b', size_bytes: 1900, layout: 'v8', reason: 'config_changes' },
    { id: 1, created_at_ms: 1767218400000, revision: 'rev-a', size_bytes: 1800, layout: 'legacy', reason: 'legacy_conversion' },
  ],
  settings: { retention: 20, retention_min: 5, retention_max: 100, legacy_retention: 10 },
};

/**
 * The fixtures, with a log of the writes and configuration reads the scenario asserts
 * against. The page itself renders from the source editor's fixtures; only its
 * configuration read is logged, which is how the reload after a restore is seen.
 */
export function configBackupsFixtures(log) {
  const pageFixtures = configSourceFixtures().map(([matches, respond]) => [matches, (url, method, request) => {
    if (url.pathname.endsWith('/management/config') && method === 'GET') log.push({ kind: 'config', method });
    return respond(url, method, request);
  }]);
  return [
    [(url) => /\/management\/config\/backups\/\d+\/restore$/.test(url.pathname), (url, method) => {
      log.push({ kind: 'restore', method, path: url.pathname });
      return { status: 'ok', revision: 'rev-restored' };
    }],
    [(url) => url.pathname.endsWith('/management/config/backups/settings'), (url, method, request) => {
      const body = JSON.parse(request.postData() ?? '{}');
      log.push({ kind: 'settings', method, body });
      return { settings: { ...BACKUPS.settings, retention: body.retention } };
    }],
    [(url) => url.pathname.endsWith('/management/config/backups'), () => BACKUPS],
    ...pageFixtures,
  ];
}

export async function configBackups({ base, page, check, log }) {
  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.locator('.config-page').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.getByRole('button', { name: /^(备份|Backups)$/ }).click();
  const dialog = page.locator('.ant-modal').filter({ has: page.locator('.ant-table') });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });

  const rows = dialog.locator('.ant-table-tbody tr.ant-table-row');
  await until(async () => (await rows.count()) === 3, { label: 'the three backup rows' });
  const reasons = await rows.evaluateAll((nodes) => nodes.map((node) => node.cells[1]?.textContent ?? ''));
  check(
    'each row names the operation it was kept before, and the pre-v8 copy is marked',
    /提供商密钥|Provider key/.test(reasons[0]) && /修改配置|Settings change/.test(reasons[1]) && /v8 之前|pre-v8/.test(reasons[2]),
    JSON.stringify(reasons),
  );
  const legacyRestore = rows.nth(2).getByRole('button', { name: /恢复|Restore/ });
  check('a pre-v8 copy cannot be restored in place', await legacyRestore.isDisabled());

  // ── retention ───────────────────────────────────────────────────────────────
  const retention = dialog.getByRole('spinbutton');
  await retention.fill('10');
  await dialog.getByRole('button', { name: /^(保存|Save)$/ }).click();
  const isRetentionSaved = await until(async () => log.some((entry) => entry.kind === 'settings'), { label: 'the retention write' })
    .then(() => true, () => false);
  const settingsWrite = log.find((entry) => entry.kind === 'settings');
  check(
    'the retention is written as a number the operator typed',
    isRetentionSaved && settingsWrite.method === 'PUT' && settingsWrite.body.retention === 10,
    JSON.stringify(settingsWrite),
  );

  // ── restore ─────────────────────────────────────────────────────────────────
  const configReadsBefore = log.filter((entry) => entry.kind === 'config').length;
  await rows.nth(1).getByRole('button', { name: /恢复|Restore/ }).click();
  const confirm = page.locator('.ant-popover .ant-popconfirm-buttons .ant-btn-primary');
  await confirm.waitFor({ state: 'visible', timeout: 10000 });
  const stacking = await confirm.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { onTop: Boolean(hit && node.contains(hit)), width: Math.round(box.width) };
  });
  check('the restore confirmation stacks above the dialog and takes the click', stacking.onTop && stacking.width > 0, JSON.stringify(stacking));
  await confirm.click();

  const isRestored = await until(async () => log.some((entry) => entry.kind === 'restore'), { label: 'the restore write' })
    .then(() => true, () => false);
  const restore = log.find((entry) => entry.kind === 'restore');
  check(
    'the confirmed restore posts the chosen copy',
    isRestored && restore.method === 'POST' && restore.path.endsWith('/management/config/backups/2/restore'),
    JSON.stringify(restore),
  );
  const isReloaded = await until(
    async () => log.filter((entry) => entry.kind === 'config').length > configReadsBefore,
    { label: 'the editor reloading after the restore' },
  ).then(() => true, () => false);
  check('the editor reloads the configuration after a restore', isReloaded, JSON.stringify(log.map((entry) => entry.kind)));
}
