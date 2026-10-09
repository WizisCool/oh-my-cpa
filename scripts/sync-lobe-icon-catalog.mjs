import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const CATALOG_PACKAGE = '@lobehub/icons';
const CATALOG_ENTRY = 'package/es/toc.json';
const REGISTRY = 'https://registry.npmjs.org';

/**
 * The console looks marks up by id and group and never needs the upstream
 * rendering parameters, so the vendored catalog keeps only the fields
 * `LobeIconCatalogEntry` declares. Everything else would be shipped in the
 * entry bundle for no reader.
 *
 * The table of contents and the SVG package are published separately and
 * disagree at the edges, so availability is read from the files the console
 * will actually request: a mark without an SVG is dropped, and `hasColor`
 * states whether the colour file exists rather than what upstream declares.
 */
export function projectLobeIconCatalog(tableOfContents, hasAsset) {
  return tableOfContents
    .filter(entry => hasAsset(`${lobeIconSlug(entry.id)}.svg`))
    .map(entry => ({
      id: entry.id,
      title: entry.title,
      fullTitle: entry.fullTitle,
      docsUrl: entry.docsUrl,
      desc: entry.desc,
      group: entry.group,
      hasColor: hasAsset(`${lobeIconSlug(entry.id)}-color.svg`),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function lobeIconSlug(iconId) {
  return iconId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Reads one file out of an uncompressed tar archive. The React icon package is
 * deliberately not a dependency (it would pull hundreds of components into the
 * module graph), so its table of contents is read straight from the published
 * tarball instead of from `node_modules`.
 */
export function readTarEntry(archive, entryName) {
  const BLOCK = 512;
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (fullName === entryName) return archive.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return undefined;
}

async function fetchChecked(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

if (process.argv[1]?.endsWith('sync-lobe-icon-catalog.mjs')) {
  const requested = process.argv[2] ?? 'latest';
  const manifest = await (await fetchChecked(`${REGISTRY}/${CATALOG_PACKAGE}/${requested}`)).json();
  const tarball = Buffer.from(await (await fetchChecked(manifest.dist.tarball)).arrayBuffer());
  const entry = readTarEntry(gunzipSync(tarball), CATALOG_ENTRY);
  if (!entry) throw new Error(`${CATALOG_PACKAGE}@${manifest.version} has no ${CATALOG_ENTRY}`);
  const require = createRequire(new URL('../web/package.json', import.meta.url));
  const assets = path.join(path.dirname(require.resolve('@lobehub/icons-static-svg/package.json')), 'icons');
  const catalog = projectLobeIconCatalog(JSON.parse(entry.toString('utf8')), name => fs.existsSync(path.join(assets, name)));
  await writeFile(new URL('../web/src/generated/lobeIconCatalog.json', import.meta.url), `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`${CATALOG_PACKAGE}@${manifest.version}: ${catalog.length} marks`);
}
