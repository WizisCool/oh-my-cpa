/**
 * Writes the brand artwork that has to exist as files: what the READMEs embed, and the favicon.
 *
 * The README files are rendered by GitHub, which cannot inline the app's SVG or read its theme
 * tokens, and the browser fetches the favicon outside the app, so both need drawing *files* on disk.
 * The app itself does not: it inlines the same artwork so the accent can follow the active theme (see
 * `web/src/assets/brand/markup.ts`).
 *
 * Those two needs used to be met by keeping four hand-maintained SVGs, which is how the mark's blue
 * drifted from the console's accent - nothing connected the two, so nothing could notice. This
 * script derives the README files from the same source the app uses.
 *
 * "The same source" has to include the *colours*, not just the drawings: reading the paths from
 * `markup.ts` while holding the accent as a literal here would have connected one half and left the
 * other free to drift, and the staleness check would have passed while the two disagreed. The
 * palette is read out of `web/src/theme/palette.ts` for that reason.
 *
 * Run it with `pnpm sync-brand`; `pnpm check-brand` fails if the committed files are stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reads one authored token out of `web/src/theme/palette.ts`.
 *
 * Parsed rather than imported because that module is TypeScript with a dependency chain this script
 * runs without, and it runs under plain Node before any bundler exists. Only the *authored* tokens
 * are readable here, which is the point: the derived ones are computed at runtime and appear nowhere
 * in the source. Both values this script asks for - `fg` and `accent` - are authored, so this stays a
 * read of a literal rather than a second implementation of the derivation.
 */
export function paletteValue(mode, key) {
  const source = fs.readFileSync(path.join(root, 'web/src/theme/palette.ts'), 'utf8');
  // The mode's default palette, selected by id rather than by being the first entry carrying that mode:
  // matching on `mode` alone would silently follow a registry reorder and paint the READMEs' wordmark in
  // another palette's accent, with nothing to fail.
  const paletteId = `omc-${mode}`;
  const entry = new RegExp(`id: '${paletteId}',[\\s\\S]*?core: \\{([\\s\\S]*?)\\n    \\},`).exec(source);
  if (!entry) throw new Error(`theme palette module has no ${paletteId} palette core`);
  const match = new RegExp(`\\b${key}: '(#[0-9a-fA-F]{3,8})'`).exec(entry[1]);
  if (!match) throw new Error(`the ${paletteId} palette has no ${key} colour`);
  return match[1];
}

/**
 * The colours the READMEs draw with, read from the app's own palette.
 *
 * The accent is the theme's link step, so the READMEs' wordmark follows it the way the console's
 * does. The ink is the palette's foreground rather than the pure black or white those files used to
 * hold: the artwork is the same drawing in both places, and GitHub's reader sees it next to the same
 * brand the console shows.
 */
export function readmeBrandColors() {
  return {
    dark: { ink: paletteValue('dark', 'fg'), accent: paletteValue('dark', 'accent') },
    light: { ink: paletteValue('light', 'fg'), accent: paletteValue('light', 'accent') },
  };
}

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
  // Anchored to the start of the entry's line: `mark` is also the tail of `wordmark`.
  const block = new RegExp(`\\n  ${shape}: \\{([\\s\\S]*?)\\n  \\},`).exec(source);
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

/**
 * Renders the mark as the favicon: one file holding both default palettes.
 *
 * A tab has no console theme to follow, so the two palettes are selected by `prefers-color-scheme`
 * inside the file. The fills therefore move from attributes into a stylesheet; an attribute cannot
 * sit behind a media query.
 */
export function renderFaviconSvg(colors) {
  const drawing = extractDrawing('mark');
  const body = drawing.body
    .split('fill="__INK__"').join('class="omc-ink"')
    .split('fill="__ACCENT__"').join('class="omc-accent"');
  if (body.includes('__')) {
    throw new Error("brand markup's mark drawing still carries a placeholder after substitution");
  }
  const rules = (palette) => `.omc-ink { fill: ${palette.ink}; } .omc-accent { fill: ${palette.accent}; }`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${drawing.viewBox}" width="${drawing.width}" height="${drawing.height}">`,
    '<title>Oh My CPA</title>',
    '<style>',
    `  ${rules(colors.light)}`,
    `  @media (prefers-color-scheme: dark) { ${rules(colors.dark)} }`,
    '</style>',
    `  ${body}`,
    '</svg>',
    '',
  ].join('\n');
}

export const FAVICON_FILE = 'web/public/favicon.svg';

/** The files the READMEs reference, and what each should contain. */
export function brandArtifacts() {
  return [
    { file: 'web/src/assets/brand/omc-wordmark-dark.svg', shape: 'wordmark', colors: readmeBrandColors().dark },
    { file: 'web/src/assets/brand/omc-wordmark-light.svg', shape: 'wordmark', colors: readmeBrandColors().light },
  ];
}

/** Every generated file with the content it should hold. */
function brandFiles() {
  return [
    ...brandArtifacts().map((artifact) => ({ file: artifact.file, wanted: renderBrandSvg(artifact.shape, artifact.colors) })),
    { file: FAVICON_FILE, wanted: renderFaviconSvg(readmeBrandColors()) },
  ];
}

export function syncBrand({ quiet = false, check = false } = {}) {
  const stale = [];
  for (const artifact of brandFiles()) {
    const target = path.join(root, artifact.file);
    const { wanted } = artifact;
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
