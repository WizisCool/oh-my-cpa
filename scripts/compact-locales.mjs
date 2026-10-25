import path from 'node:path';
import { buildSync } from 'esbuild';

/**
 * The catalog module as a plain object, evaluated with the module graph Vite itself would resolve.
 *
 * Bundling rather than reading the domain files one by one is what makes the key order below the
 * catalogue's real order: an index file spreads its domain files in the sequence it declares, and
 * that sequence is what decides which value belongs to which id. A local copy of that rule - the
 * files sorted by name, say - would line values up against the wrong ids and produce a console that
 * reads fluently in the wrong places, so the order is taken from the module rather than restated.
 */
function evaluateCatalog(file) {
  const result = buildSync({
    entryPoints: [file],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  const module = { exports: {} };
  const evaluate = new Function('exports', 'module', result.outputFiles[0].text);
  evaluate(module.exports, module);
  return module.exports.default;
}

/**
 * A production-build plugin that stores English as values aligned with the source catalog's ids.
 *
 * Both the source language and English are part of the first paint, so every English key is a
 * second copy of an id the source already carries - about 80 KiB of duplicated identifiers in the
 * entry chunk, which is what pushed startup JavaScript past its ceiling when the catalogs moved
 * from one bilingual table into per-language files. The authored files stay exactly as they are -
 * one file per language per area, typed key by key, which is what a translator edits - and only the
 * built English module is reshaped: it imports the source for its ids and supplies the sentences in
 * that order.
 *
 * The alignment is structural, not assumed: the ids and the values come from the same two modules,
 * and a key the English module is missing throws here rather than shipping as a blank sentence. Only
 * English is reshaped - the deferred catalogs are fetched on their own and cost nothing at startup.
 */
export function compactEnglishCatalogPlugin(repoRoot) {
  const locales = path.join(repoRoot, 'web', 'src', 'i18n', 'locales');
  return {
    name: 'compact-en-catalog',
    apply: 'build',
    load(id) {
      if (id.replace(/\\/g, '/') !== path.join(locales, 'en', 'index.ts').replace(/\\/g, '/')) return null;
      const source = evaluateCatalog(path.join(locales, 'zh', 'index.ts'));
      const english = evaluateCatalog(path.join(locales, 'en', 'index.ts'));
      const ids = Object.keys(source);
      const values = ids.map((id) => english[id]);
      const uncovered = ids.filter((id, index) => typeof values[index] !== 'string');
      if (uncovered.length > 0) {
        throw new Error(`the English catalog has no sentence for ${uncovered.length} id(s), first: ${uncovered[0]}`);
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
