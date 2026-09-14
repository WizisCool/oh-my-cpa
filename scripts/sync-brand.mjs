/**
 * Writes the brand artwork the READMEs embed.
 *
 * The README files are rendered by GitHub, which cannot inline the app's SVG or read its theme
 * tokens, so they need drawing *files* on disk. The app itself does not: it inlines the same artwork
 * so the accent can follow the active theme (see `web/src/assets/brand/markup.ts`).
 *
 * Those two needs used to be met by keeping four hand-maintained SVGs, which is how the mark's blue
 * drifted from the console's accent - nothing connected the two, so nothing could notice. This
 * script derives the README files from the same source the app uses, which makes the drift
 * impossible rather than merely unlikely.
 *
 * Run it with `pnpm sync-brand`; `pnpm check-docs` fails if the committed files are stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The colours the READMEs draw with.
 *
 * Read from the same palette the app's theme config mirrors, so a change to the accent moves the
 * READMEs too. The values are duplicated from `web/src/theme/themeConfig.ts` rather than imported:
 * that module is TypeScript with a React dependency chain, and this script runs under plain Node
 * before any bundler exists.
 */
export const README_BRAND_COLORS = {
  dark: { ink: '#FFFFFF', accent: '#00a2fb' },
  light: { ink: '#181A1F', accent: '#005d8f' },
};

function markupSource() {
  return fs.readFileSync(path.join(root, 'web/src/assets/brand/markup.ts'), 'utf8');
}

/**
 * Extracts one drawing's body and geometry from the markup module.
 *
 * Parsed rather than imported because the module is TypeScript. The shape is asserted after every
 * extraction, so a change to the module's format fails here loudly instead of silently writing a
 * broken SVG.
 */
function extractDrawing(shape) {
  const source = markupSource();
  const block = new RegExp(`${shape}: \\{([\\s\\S]*?)\\n  \\},`).exec(source);
  if (!block) throw new Error(`brand markup has no drawing named ${shape}`);
  const [, body] = block;
  const viewBox = /viewBox: '([^']+)'/.exec(body);
  const width = /width: (\d+)/.exec(body);
  const height = /height: (\d+)/.exec(body);
  const paths = /body: `([\s\S]*?)`,/.exec(body);
  if (!viewBox || !width || !height || !paths) {
    throw new Error(`brand markup's ${shape} drawing is missing geometry or its body`);
  }
  return { viewBox: viewBox[1], width: width[1], height: height[1], body: paths[1] };
}

/** Renders one drawing as a standalone SVG document, with its placeholders substituted. */
export function renderBrandSvg(shape, colors) {
  const drawing = extractDrawing(shape);
  const body = drawing.body
    .split('__INK__').join(colors.ink)
    .split('__ACCENT__').join(colors.accent);
  if (body.includes('__')) {
    throw new Error(`brand markup's ${shape} drawing still carries a placeholder after substitution`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${drawing.viewBox}" width="${drawing.width}" height="${drawing.height}">${body}</svg>\n`;
}

/** The files the READMEs reference, and what each should contain. */
export function brandArtifacts() {
  return [
    { file: 'web/src/assets/brand/omc-wordmark-dark.svg', shape: 'wordmark', colors: README_BRAND_COLORS.dark },
    { file: 'web/src/assets/brand/omc-wordmark-light.svg', shape: 'wordmark', colors: README_BRAND_COLORS.light },
  ];
}

export function syncBrand({ quiet = false, check = false } = {}) {
  const stale = [];
  for (const artifact of brandArtifacts()) {
    const target = path.join(root, artifact.file);
    const wanted = renderBrandSvg(artifact.shape, artifact.colors);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === wanted) continue;
    if (check) {
      stale.push(artifact.file);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, wanted);
    if (!quiet) console.log(`brand: wrote ${artifact.file}`);
  }
  return stale;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const stale = syncBrand({ check: process.argv.includes('--check') });
  if (stale.length > 0) {
    console.error(`brand artwork is stale, run \`pnpm sync-brand\`: ${stale.join(', ')}`);
    process.exitCode = 1;
  }
}
