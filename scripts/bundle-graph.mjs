import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function normalizeModuleId(moduleId, root) {
  const normalized = moduleId.replaceAll('\\', '/').split('?')[0];
  const packageOffset = normalized.lastIndexOf('/node_modules/');
  if (packageOffset >= 0) return normalized.slice(packageOffset + 1);
  const relative = path.relative(root, normalized).replaceAll('\\', '/');
  return relative.startsWith('web/src/') ? relative : null;
}

// Record Rollup's actual ownership and import edges, not content-hash filenames.
// The graph lives outside dist: source metadata must never enter the embedded SPA.
export function bundleGraphPlugin(root) {
  return {
    name: 'bundle-loading-graph',
    apply: 'build',
    writeBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk').map((chunk) => ({
        file: chunk.fileName,
        imports: chunk.imports,
        dynamicImports: chunk.dynamicImports,
        css: [...(chunk.viteMetadata?.importedCss ?? [])],
        modules: Object.entries(chunk.modules).filter(([, metadata]) => metadata.renderedLength !== 0).map(([moduleId]) => normalizeModuleId(moduleId, root)).filter(Boolean).sort(),
        sha256: createHash('sha256').update(chunk.code).digest('hex'),
      })).sort((left, right) => left.file.localeCompare(right.file));
      const directory = path.join(root, 'tmp/bundle');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'graph.json'), `${JSON.stringify({ version: 1, chunks }, null, 2)}\n`);
    },
  };
}
