import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// These are anomaly ceilings, not feature allowances or latency guarantees.
export const ANOMALY_LIMITS = {
  initialJS: { raw: 3072 * 1024, gzip: 1024 * 1024 },
  initialCSS: { raw: 256 * 1024, gzip: 96 * 1024 },
  largestJS: { raw: 4096 * 1024 },
  totalJS: { raw: 16 * 1024 * 1024 },
  totalDist: { raw: 20 * 1024 * 1024 },
  lobeSVG: { raw: 2 * 1024 * 1024 },
};

export function measureBytes(bytes) {
  return { raw: bytes.length, gzip: gzipSync(bytes, { level: 6 }).length };
}

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in distribution: ${relative}`);
    return entry.isDirectory() ? listFiles(path.join(directory, entry.name), `${relative}/`) : [relative];
  }).sort();
}

function parseAttributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1].toLowerCase(), match[2]]));
}

function resolveAsset(reference) {
  const url = new URL(reference, 'https://bundle.invalid/');
  if (url.origin !== 'https://bundle.invalid') throw new Error(`External startup resource: ${reference}`);
  // Vite base is relative; mount prefixes never belong to on-disk asset names.
  const assetOffset = url.pathname.indexOf('/assets/');
  if (assetOffset < 0) throw new Error(`Startup resource is not a built asset: ${reference}`);
  return decodeURIComponent(url.pathname.slice(assetOffset + 1));
}

export function collectStartupResources(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  const modules = scripts.filter((attributes) => attributes.type === 'module' && attributes.src).map((attributes) => resolveAsset(attributes.src));
  if (modules.length !== 1) throw new Error('The built HTML must have exactly one module entry');
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  return {
    entry: modules[0],
    scripts: [...modules, ...links.filter((attributes) => attributes.rel === 'modulepreload').map((attributes) => resolveAsset(attributes.href))],
    css: links.filter((attributes) => attributes.rel === 'stylesheet').map((attributes) => resolveAsset(attributes.href)),
  };
}

export function walkStaticGraph(chunks, roots) {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    const chunk = byFile.get(file);
    if (!chunk) throw new Error(`Missing chunk in static graph: ${file}`);
    visited.add(file);
    for (const imported of chunk.imports) visit(imported);
  }
  for (const root of roots) visit(root);
  return [...visited].sort();
}

function isDeferredModule(moduleId) {
  return moduleId.startsWith('web/src/pages/')
    || moduleId === 'web/src/components/common/AppLayout.tsx'
    || moduleId === 'web/src/components/config/YamlSourceEditor.tsx'
    || /^node_modules\/(?:@antv\/|@ant-design\/(?:charts|plots)\/|monaco-editor\/|react-markdown\/|remark-gfm\/)/.test(moduleId);
}

export function findLoadingViolations(chunks, initialFiles) {
  const initial = new Set(initialFiles);
  const violations = chunks.filter((chunk) => initial.has(chunk.file)).flatMap((chunk) =>
    chunk.modules.filter(isDeferredModule).map((moduleId) => `${moduleId} is eager through ${chunk.file}`));
  const configRoots = chunks.filter((chunk) => chunk.modules.includes('web/src/pages/ConfigPage.tsx')).map((chunk) => chunk.file);
  if (configRoots.length === 0) violations.push('Missing ConfigPage module ownership; cannot verify the on-demand editor boundary');
  const configFiles = new Set(walkStaticGraph(chunks, configRoots));
  for (const chunk of chunks.filter((candidate) => configFiles.has(candidate.file))) {
    for (const moduleId of chunk.modules) {
      if (moduleId === 'web/src/components/config/YamlSourceEditor.tsx' || moduleId.startsWith('node_modules/monaco-editor/')) {
        violations.push(`${moduleId} loads with ConfigPage instead of the on-demand editor through ${chunk.file}`);
      }
    }
  }
  return violations;
}

function sumSizes(files, inventory) {
  return files.reduce((total, file) => {
    const size = inventory[file];
    if (!size) throw new Error(`Missing built resource: ${file}`);
    return { raw: total.raw + size.raw, gzip: total.gzip + size.gzip };
  }, { raw: 0, gzip: 0 });
}

export function analyzeBundle(distDirectory, graph, revision) {
  if (graph.version !== 1 || !Array.isArray(graph.chunks) || graph.chunks.length === 0) throw new Error('Missing or unsupported bundle graph; run pnpm build');
  const inventory = {};
  for (const file of listFiles(distDirectory)) {
    const bytes = fs.readFileSync(path.join(distDirectory, file));
    inventory[file] = { ...measureBytes(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const chunkFiles = new Set();
  for (const chunk of graph.chunks) {
    if (chunkFiles.has(chunk.file)) throw new Error(`Duplicate graph chunk: ${chunk.file}`);
    chunkFiles.add(chunk.file);
    if (inventory[chunk.file]?.sha256 !== chunk.sha256) throw new Error(`Stale bundle graph for ${chunk.file}; run pnpm build`);
    if (!Array.isArray(chunk.modules) || !Array.isArray(chunk.imports) || !Array.isArray(chunk.dynamicImports) || !Array.isArray(chunk.css)) throw new Error(`Invalid chunk metadata: ${chunk.file}`);
    for (const imported of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!graph.chunks.some((candidate) => candidate.file === imported)) throw new Error(`Missing imported chunk: ${imported}`);
    }
    for (const stylesheet of chunk.css) {
      if (!inventory[stylesheet]) throw new Error(`Missing built resource: ${stylesheet}`);
    }
  }
  const startup = collectStartupResources(fs.readFileSync(path.join(distDirectory, 'index.html'), 'utf8'));
  const initialFiles = walkStaticGraph(graph.chunks, startup.scripts);
  const initialCSS = [...new Set([...startup.css, ...graph.chunks.filter((chunk) => initialFiles.includes(chunk.file)).flatMap((chunk) => chunk.css)])].sort();
  const files = Object.keys(inventory);
  const javascript = files.filter((file) => file.endsWith('.js'));
  const largest = javascript.reduce((largestFile, file) => inventory[file].raw > (inventory[largestFile]?.raw ?? -1) ? file : largestFile, '');
  return {
    version: 1,
    revision,
    entry: startup.entry,
    initialFiles,
    initialCSS,
    metrics: {
      entry: inventory[startup.entry],
      initialJS: sumSizes(initialFiles, inventory),
      initialCSS: sumSizes(initialCSS, inventory),
      largestJS: inventory[largest],
      totalJS: sumSizes(javascript, inventory),
      totalDist: sumSizes(files, inventory),
      lobeSVG: sumSizes(files.filter((file) => file.startsWith('lobe-icons/') && file.endsWith('.svg')), inventory),
    },
    files: inventory,
    chunks: graph.chunks.map((chunk) => ({ file: chunk.file, sources: chunk.modules.filter((moduleId) => moduleId.startsWith('web/src/')) })),
    violations: findLoadingViolations(graph.chunks, initialFiles),
  };
}

export function validateReference(reference, expectedRevision) {
  if (reference?.version !== 1 || !/^[a-f\d]{40}$/.test(reference.revision) || reference.revision !== expectedRevision) return false;
  return ['entry', 'initialJS', 'initialCSS', 'largestJS', 'totalJS', 'totalDist', 'lobeSVG'].every((metric) =>
    ['raw', 'gzip'].every((encoding) => Number.isSafeInteger(reference.metrics?.[metric]?.[encoding]) && reference.metrics[metric][encoding] >= 0));
}

export function evaluateBundle(report, reference = null) {
  const failures = [...report.violations];
  const warnings = [];
  for (const [metric, limits] of Object.entries(ANOMALY_LIMITS)) {
    for (const [encoding, limit] of Object.entries(limits)) {
      if (report.metrics[metric][encoding] > limit) failures.push(`${metric} ${encoding} exceeds anomaly ceiling ${limit / 1024} KiB`);
    }
  }
  if (reference) {
    for (const metric of Object.keys(report.metrics)) {
      for (const encoding of ['raw', 'gzip']) {
        const previous = reference.metrics[metric][encoding];
        const growth = report.metrics[metric][encoding] - previous;
        const minimum = metric.startsWith('initial') || metric === 'entry' ? 16 * 1024 : 128 * 1024;
        if (growth > minimum && growth > previous * 0.1) warnings.push(`${metric} ${encoding} grew ${(growth / 1024).toFixed(2)} KiB (${previous ? (growth / previous * 100).toFixed(1) : 'new'}%)`);
      }
    }
  }
  return { failures, warnings };
}

export function renderBundleSummary(report, reference, result) {
  const lines = [
    '## Bundle loading and size report',
    '',
    `Build revision: ${report.revision}. Reference: ${reference ? reference.revision : 'unavailable (growth comparison not performed)'}.`,
    '',
    'Sizes are KiB. Gzip is a level-6 estimate per file, not measured transfer or browser execution time.',
    '',
    '| Metric | Raw | Gzip | Raw delta | Gzip delta |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const [metric, size] of Object.entries(report.metrics)) {
    const delta = (encoding) => reference ? `${((size[encoding] - reference.metrics[metric][encoding]) / 1024).toFixed(2)}` : '—';
    lines.push(`| ${metric} | ${(size.raw / 1024).toFixed(2)} | ${(size.gzip / 1024).toFixed(2)} | ${delta('raw')} | ${delta('gzip')} |`);
  }
  lines.push('', '### Largest JavaScript files', '', '| File | Raw KiB | Gzip KiB | Startup |', '| --- | ---: | ---: | --- |');
  for (const [file, size] of Object.entries(report.files).filter(([file]) => file.endsWith('.js')).sort((left, right) => right[1].raw - left[1].raw).slice(0, 10)) {
    lines.push(`| ${file} | ${(size.raw / 1024).toFixed(2)} | ${(size.gzip / 1024).toFixed(2)} | ${report.initialFiles.includes(file) ? 'yes' : 'no'} |`);
  }
  lines.push('', `Startup JS: ${report.initialFiles.join(', ')}`, '', `Loading boundaries and anomaly ceilings: ${result.failures.length ? 'FAIL' : 'PASS'}.`);
  for (const message of result.failures) lines.push(`- FAIL: ${message}`);
  for (const message of result.warnings) lines.push(`- WARNING: ${message}`);
  return `${lines.join('\n')}\n`;
}
