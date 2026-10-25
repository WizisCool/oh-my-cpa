import fs from 'node:fs';
import path from 'node:path';

/**
 * A catalog module's exported object, evaluated without a bundler.
 *
 * A catalog module is data: type-only imports (erased by any TypeScript build), one `export default`
 * of an object literal, and optionally a `satisfies` clause. Evaluating it here rather than parsing
 * its text is what keeps values exact - the JavaScript engine handles every escape, quote and
 * newline a sentence may contain - and reading no dependency is what keeps the build hook working
 * on a machine that has only the workspace's own packages installed.
 *
 * Anything else in the file throws instead of being ignored: a module whose shape changed must fail
 * the build rather than silently contribute a partial catalog.
 */
function evaluateCatalogModule(file) {
  const source = fs.readFileSync(file, 'utf8');
  const body = source
    .replace(/^import\s+type\s[^;]*;\s*$/gm, '')
    .replace(/^export default/m, 'module.exports =')
    .replace(/\}\s*satisfies\s+[^;]*;\s*$/m, '};');
  // A statement that survived the rewrite is a shape this hook does not read, so the build stops
  // rather than shipping a catalog it only partly understood.
  if (/^\s*(?:import|export)\s/m.test(body)) {
    throw new Error(`${file}: a catalog module may only declare type imports and one default export`);
  }
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', body)(module, module.exports);
  const catalog = module.exports;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error(`${file}: a catalog module must export its messages as an object`);
  }
  return catalog;
}

/**
 * The area files an index module joins, in the order it joins them.
 *
 * The order comes from the index file itself rather than from a directory listing or a list kept
 * here: the index is what the console loads, so a file it does not name must not reach the built
 * catalog, and a file it names early must not land late.
 */
function areaOrder(indexFile) {
  const source = fs.readFileSync(indexFile, 'utf8');
  const areas = [...source.matchAll(/^import\s+\w+\s+from\s+'(\.\/[^']+)';/gm)].map((match) => match[1]);
  if (areas.length === 0) throw new Error(`${indexFile}: the index names no area module`);
  return areas;
}

/**
 * A production-build plugin that stores English as values aligned with the source catalog's ids.
 *
 * Both the source language and English are part of the first paint, so every English key is a
 * second copy of an id the source already carries - about 80 KiB of duplicated identifiers in the
 * entry chunk. The authored files stay exactly as they are: one typed file per language per area,
 * which is what a translator edits, and what the type checker and the development server read. Only
 * the built English module is reshaped, so it imports the source for its ids and supplies the
 * sentences in that order.
 *
 * Alignment is structural rather than positional. Each area's ids are read from the source file and
 * matched to English by name, so a reordered or renamed key is a build error instead of a sentence
 * appearing under another id; the deferred catalogs are not touched at all, since they are fetched
 * on their own and cost nothing at startup.
 */
export function compactEnglishCatalogPlugin(repoRoot) {
  const locales = path.join(repoRoot, 'web', 'src', 'i18n', 'locales');
  return {
    name: 'compact-en-catalog',
    apply: 'build',
    load(id) {
      const target = path.join(locales, 'en', 'index.ts');
      if (id.replace(/\\/g, '/') !== target.replace(/\\/g, '/')) return null;
      const areas = areaOrder(path.join(locales, 'zh', 'index.ts'));
      const values = [];
      for (const area of areas) {
        const source = evaluateCatalogModule(path.join(locales, 'zh', area.replace(/^\.\//, '') + '.ts'));
        const english = evaluateCatalogModule(path.join(locales, 'en', area.replace(/^\.\//, '') + '.ts'));
        for (const [key, sentence] of Object.entries(source)) {
          const translated = english[key];
          if (typeof translated !== 'string') {
            throw new Error(`${area}: the English catalog has no sentence for "${key}"`);
          }
          if (typeof sentence !== 'string') throw new Error(`${area}: "${key}" is not a sentence`);
          values.push(translated);
        }
      }
      return [
        `import source from '../zh';`,
        `const values = ${JSON.stringify(values)};`,
        `export default Object.fromEntries(Object.keys(source).map((id, index) => [id, values[index]]));`,
        '',
      ].join('\n');
    },
  };
}
