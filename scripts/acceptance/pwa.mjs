/**
 * Installable-app acceptance against the built binary and its embedded console.
 *
 * Installability is a browser decision, so it cannot be proven by reading the manifest
 * file: Chromium has to parse the manifest, accept its icons and produce no installability
 * error. This suite's browser context blocks service workers, so a passing check is also
 * evidence that installation does not depend on one - the decision this change records.
 * That is what the scenario asks the browser itself (Page.getAppManifest /
 * Page.getInstallabilityErrors), and it also holds the deployment's own contract around
 * it: the manifest is served with the manifest MIME type and revalidates, every icon it
 * names loads, and a deep link resolves the same manifest to the same mount.
 */
export async function runPwaAcceptance({ appURL, context, page, check }) {
  const mount = appURL.replace(/\/+$/, '');
  const start = `${mount}/`;
  const cdps = await context.newCDPSession(page);
  await cdps.send('Page.enable');

  const readManifest = async () => {
    const { errors, url, manifest } = await cdps.send('Page.getAppManifest');
    const { installabilityErrors } = await cdps.send('Page.getInstallabilityErrors');
    return { errors, url, manifest, installabilityErrors };
  };

  await page.goto(start, { waitUntil: 'load' });
  const shallow = await readManifest();

  check('the manifest parses with no errors', shallow.errors.length === 0, JSON.stringify(shallow.errors));
  check('the manifest is served from beside the app', shallow.url === `${start}manifest.webmanifest`, shallow.url);
  check('Chromium reports no installability error', shallow.installabilityErrors.length === 0, JSON.stringify(shallow.installabilityErrors));
  check('the manifest declares a standalone display', String(shallow.manifest.display).toLowerCase().includes('standalone'), String(shallow.manifest.display));
  check('start_url is the mount', shallow.manifest.startUrl === start, String(shallow.manifest.startUrl));
  check('scope is the mount', shallow.manifest.scope === start, String(shallow.manifest.scope));
  // The manifest carries no id, so the browser's processed identity is the resolved
  // start_url. A relative id would have resolved against start_url's origin and named the
  // site root here instead.
  check('the installed identity is the mount', shallow.manifest.id === start, String(shallow.manifest.id));
  check('the manifest declares a name', Boolean(shallow.manifest.name || shallow.manifest.shortName), String(shallow.manifest.name ?? shallow.manifest.shortName));

  const manifestResponse = await page.request.get(shallow.url);
  check('the manifest is served', manifestResponse.status() === 200, String(manifestResponse.status()));
  check('the manifest has the manifest MIME type', manifestResponse.headers()['content-type'] === 'application/manifest+json', manifestResponse.headers()['content-type']);
  check('the manifest revalidates rather than being immutable', manifestResponse.headers()['cache-control'] === 'no-cache', manifestResponse.headers()['cache-control']);

  const manifest = JSON.parse(await manifestResponse.text());
  const declaredSizes = new Set();
  for (const icon of manifest.icons) {
    const iconURL = new URL(icon.src, shallow.url);
    const iconResponse = await page.request.get(iconURL.href);
    const bytes = (await iconResponse.body()).length;
    check(`the icon ${icon.src} loads`, iconResponse.status() === 200 && bytes > 0, `status=${iconResponse.status()} bytes=${bytes}`);
    check(`the icon ${icon.src} has the declared type`, iconResponse.headers()['content-type'] === icon.type, iconResponse.headers()['content-type']);
    for (const size of icon.sizes.split(/\s+/)) declaredSizes.add(size);
  }
  // Chromium's installability criteria; the errors above already cover them, and this
  // keeps a manifest that silently stops declaring a usable size from passing.
  check('the manifest declares a 192px icon', declaredSizes.has('192x192'), [...declaredSizes].join(' '));
  check('the manifest declares a 512px icon', declaredSizes.has('512x512'), [...declaredSizes].join(' '));

  const appleIcon = await page.evaluate(() => document.querySelector('link[rel="apple-touch-icon"]')?.href ?? '');
  check('the shell declares an iOS touch icon', appleIcon === `${start}icons/apple-touch-icon.png`, appleIcon);
  const appleResponse = await page.request.get(appleIcon);
  check('the iOS touch icon loads', appleResponse.status() === 200 && (await appleResponse.body()).length > 0, String(appleResponse.status()));

  // A deep link is served the shell at its own path, so the manifest link only resolves
  // back to the mount because the server injects the mount as the document base.
  await page.goto(`${start}usage/events`, { waitUntil: 'load' });
  const deep = await readManifest();
  check('a deep link parses the same manifest', deep.url === `${start}manifest.webmanifest` && deep.errors.length === 0, `${deep.url} ${JSON.stringify(deep.errors)}`);
  check('a deep link keeps the mount identity', deep.manifest.id === start && deep.manifest.startUrl === start, String(deep.manifest.id));
  check('a deep link is installable', deep.installabilityErrors.length === 0, JSON.stringify(deep.installabilityErrors));
  const base = await page.evaluate(() => document.querySelector('base')?.href ?? '');
  check('a deep link carries the mount as its base', base === start, base);
}
