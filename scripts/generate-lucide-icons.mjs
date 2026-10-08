import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'web', 'package.json'));
export const LUCIDE_ICONS_PATH = path.join(root, 'web', 'src', 'generated', 'lucideIcons.json');

/**
 * The Agent's panels name icons freely (ADR 0079), so the console needs the whole Lucide set at
 * hand - but only as drawing data, and only once a panel asks for one. Importing the set as React
 * components would put two thousand modules in the startup graph, and importing each on demand
 * would embed two thousand chunks in the binary. One generated JSON document, loaded lazily, is
 * neither: every name maps to its SVG nodes, and a retired name maps to the name that replaced it.
 */
export async function buildLucideIcons() {
  const packageRoot = path.dirname(require.resolve('lucide-react/package.json'));
  const directory = path.join(packageRoot, 'dist', 'esm', 'icons');
  const icons = {};
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.mjs') && name !== 'index.mjs').sort()) {
    const name = file.slice(0, -'.mjs'.length);
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    const alias = /export \{ default \} from '\.\/([a-z0-9-]+)\.mjs'/.exec(source);
    if (alias) {
      icons[name] = alias[1];
      continue;
    }
    const module = await import(pathToFileURL(path.join(directory, file)).href);
    icons[name] = module.__iconData.node.map(([tag, { key: _key, ...attributes }]) => [tag, attributes]);
  }
  return `${JSON.stringify(icons)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = await buildLucideIcons();
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(LUCIDE_ICONS_PATH) || fs.readFileSync(LUCIDE_ICONS_PATH, 'utf8') !== next) {
      console.error('web/src/generated/lucideIcons.json is stale: run `pnpm icons:generate`');
      process.exit(1);
    }
  } else {
    fs.writeFileSync(LUCIDE_ICONS_PATH, next);
    console.log(`wrote ${Object.keys(JSON.parse(next)).length} icons`);
  }
}
