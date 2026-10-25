/**
 * The translation gate: structural and formatting checks for the i18n catalogs.
 *
 * The compiler already proves the per-file key sets (`satisfies Translation<typeof source>`). What
 * this automated gate verifies:
 *
 * - The registry, locale directories and language-switcher flags strictly agree;
 * - No id is defined in multiple domain files (preventing silent overwrite during catalog assembly);
 * - Balanced braces, valid ICU plural structures (mandatory `other` branch, valid category names);
 * - Each translation reads the exact same placeholders as its source sentence;
 * - Empty, whitespace-padded, or structurally malformed translation values are rejected;
 * - Every key in the source catalog is referenced somewhere in codebase or through a computed prefix;
 * - Every registered Agent capability has localized copy.
 *
 * Whether a sentence reads naturally is a linguistic question requiring native review: `--report`
 * lists entries that share verbatim strings with their source language for targeted human audit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { messagePlaceholders, pluralBranches } from '../web/src/i18n/format.ts';
import { LANGUAGES } from '../web/src/i18n/language.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(ROOT, 'web', 'src', 'i18n');
const LOCALES = path.join(I18N, 'locales');
const SOURCE_LANG = 'zh';

type Messages = Record<string, string>;

export interface Problem {
  kind: string;
  message: string;
}

async function loadModule(file: string): Promise<Messages> {
  return (await import(pathToFileURL(file).href)).default as Messages;
}

function domainFiles(lang: string): string[] {
  return fs.readdirSync(path.join(LOCALES, lang)).filter((name) => name.endsWith('.ts') && name !== 'index.ts').sort();
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (fullPath !== LOCALES) files.push(...sourceFiles(fullPath));
    } else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Strips comments so a key or a Chinese word mentioned in prose does not count as code. */
function withoutComments(text: string): string {
  // Newlines inside a block comment are kept, so a reported line number is still the file's.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function validateTemplateFormat(template: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < template.length; i++) {
    if (template[i] === '{') depth++;
    else if (template[i] === '}') {
      depth--;
      if (depth < 0) return 'unmatched closing brace `}`';
    }
  }
  if (depth !== 0) return 'unclosed opening brace `{`';

  let index = 0;
  while (index < template.length) {
    const open = template.indexOf('{', index);
    if (open < 0) break;
    let d = 0;
    let close = -1;
    for (let j = open; j < template.length; j++) {
      if (template[j] === '{') d++;
      else if (template[j] === '}') {
        d--;
        if (d === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) break;
    const body = template.slice(open + 1, close);
    const pluralHead = /^\s*([A-Za-z0-9_]+)\s*,\s*plural\s*,/.exec(body);
    if (pluralHead) {
      const remainder = body.slice(pluralHead[0].length);
      const branches = pluralBranches(remainder);
      if (!branches.has('other')) return 'a plural form needs an `other` branch';
      for (const [category, text] of branches.entries()) {
        if (!/^(=[0-9]+|zero|one|two|few|many|other)$/.test(category)) {
          return `invalid plural category: "${category}"`;
        }
        const inner = validateTemplateFormat(text);
        if (inner) return `inside plural branch "${category}": ${inner}`;
      }
    }
    index = close + 1;
  }
  return undefined;
}

export async function checkCatalogs(): Promise<{ problems: Problem[]; report: string[] }> {
  const problems: Problem[] = [];
  const report: string[] = [];
  const fail = (kind: string, message: string) => problems.push({ kind, message });

  // Registry, directories and flags.
  const registered = LANGUAGES.map((language) => language.id as string);
  const directories = fs.readdirSync(LOCALES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const id of registered) {
    if (!directories.includes(id)) fail('registry', `language "${id}" is registered but web/src/i18n/locales/${id} is not a directory`);
  }
  for (const id of directories) {
    if (!registered.includes(id)) fail('registry', `web/src/i18n/locales/${id} is not registered in web/src/i18n/language.ts`);
  }
  const flags = fs.readFileSync(path.join(ROOT, 'web', 'src', 'components', 'common', 'LanguageFlag.tsx'), 'utf8');
  for (const language of LANGUAGES) {
    if (!new RegExp(`^\\s*${language.country}: `, 'm').test(flags)) fail('registry', `language "${language.id}" names flag ${language.country}, which LanguageFlag.tsx does not draw`);
  }

  // The source catalog: ids are unique across its files.
  const sourceDomains = domainFiles(SOURCE_LANG);
  const owners = new Map<string, string>();
  const source: Messages = {};
  for (const file of sourceDomains) {
    const messages = await loadModule(path.join(LOCALES, SOURCE_LANG, file));
    for (const [key, value] of Object.entries(messages)) {
      const owner = owners.get(key);
      if (owner) fail('duplicate', `"${key}" is defined in both ${owner} and ${file}`);
      owners.set(key, file);
      source[key] = value;
    }
  }

  // Every language, against the source.
  const catalogs = new Map<string, Messages>();
  for (const lang of registered) {
    const files = domainFiles(lang);
    for (const file of sourceDomains) if (!files.includes(file)) fail('structure', `locales/${lang}/ has no ${file}`);
    for (const file of files) if (!sourceDomains.includes(file)) fail('structure', `locales/${lang}/${file} has no source file in locales/${SOURCE_LANG}/`);
    const index = fs.readFileSync(path.join(LOCALES, lang, 'index.ts'), 'utf8');
    for (const file of files) {
      if (!index.includes(`from './${file.replace(/\.ts$/, '')}'`)) fail('structure', `locales/${lang}/index.ts does not import ${file}`);
    }
    // Files are kept in the source's order, so a reviewer can read two languages side by side.
    for (const file of files.filter((name) => sourceDomains.includes(name))) {
      const sourceOrder = Object.keys(await loadModule(path.join(LOCALES, SOURCE_LANG, file)));
      const order = Object.keys(await loadModule(path.join(LOCALES, lang, file)));
      const misplaced = order.findIndex((key, index) => key !== sourceOrder[index]);
      if (misplaced >= 0 && order.length === sourceOrder.length) {
        fail('order', `locales/${lang}/${file}: "${order[misplaced]}" is out of order; the source has "${sourceOrder[misplaced]}" there`);
      }
    }
    const catalog = await loadModule(path.join(LOCALES, lang, 'index.ts'));
    catalogs.set(lang, catalog);
  }

  for (const lang of registered) {
    const catalog = catalogs.get(lang);
    if (!catalog) continue;
    for (const [key, sourceValue] of Object.entries(source)) {
      const value = catalog[key];
      if (typeof value !== 'string') {
        fail('missing', `${lang}: "${key}" has no translation`);
        continue;
      }
      if (value.trim() === '' && sourceValue.trim() !== '') fail('empty', `${lang}: "${key}" is empty`);
      if (value !== value.trim() && sourceValue === sourceValue.trim()) fail('whitespace', `${lang}: "${key}" has leading or trailing whitespace`);
      const expected = messagePlaceholders(sourceValue).join(', ');
      const actual = messagePlaceholders(value).join(', ');
      if (expected !== actual) fail('placeholder', `${lang}: "${key}" reads {${actual}} but the source reads {${expected}}`);
      const formatProblem = validateTemplateFormat(value);
      if (formatProblem) fail('format', `${lang}: "${key}": ${formatProblem}`);
    }
  }

  // A Chinese catalog written in the other script. Copying a sentence from `zh` into `zh-Hant`
  // leaves a Simplified character in Hong Kong copy - the failure this catalog is most exposed to,
  // and the one a reader notices first. Only characters whose two forms are never interchangeable
  // are listed: the shared glyphs (端, 印) and the context-dependent ones (後/后, 裡/里) would
  // produce false positives, and a gate that cries wolf is a gate people turn off.
  for (const [lang, wrongScript, name] of [
    ['zh-Hant', SIMPLIFIED_ONLY, 'Simplified'],
    ['zh', TRADITIONAL_ONLY, 'Traditional'],
  ] as const) {
    const catalog = catalogs.get(lang);
    if (!catalog) continue;
    for (const character of wrongScript) {
      const key = Object.keys(catalog).find((id) => catalog[id].includes(character));
      if (key) fail('script', `${lang}: "${key}" uses ${character}, ${name} script, in a catalog written the other way`);
    }
  }

  // Every id is referenced, by its literal or by a computed prefix such as `insights.metric.${...}`.
  const code = sourceFiles(path.join(ROOT, 'web', 'src')).map((file) => withoutComments(fs.readFileSync(file, 'utf8'))).join('\n');
  const literals = new Set(code.match(/['"`][A-Za-z0-9_.-]+['"`]/g)?.map((literal) => literal.slice(1, -1)) ?? []);
  const prefixes = [...code.matchAll(/`([a-z_]+\.[A-Za-z0-9_.-]*)\$\{/g)].map((match) => match[1]);
  for (const key of Object.keys(source)) {
    if (literals.has(key)) continue;
    if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
    if (key.startsWith(CAPABILITY_PREFIX)) continue;
    fail('unused', `"${key}" (${owners.get(key)}) is not referenced by any source file`);
  }

  // Capability copy is looked up by computed id, so the reference scan cannot see a missing one.
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy', 'cloudflare', 'data', 'responses.json'), 'utf8'));
  const names = new Set<string>(JSON.parse(dataset.responses.capabilities.body).capabilities.map((capability: { name: string }) => capability.name));
  for (const name of names) {
    for (const key of [`${CAPABILITY_PREFIX}${name}`, `${CAPABILITY_PREFIX}${name}.description`]) {
      if (!(key in source)) fail('capability', `capability "${name}" has no copy "${key}"`);
    }
  }
  for (const key of Object.keys(source)) {
    if (key.startsWith(CAPABILITY_PREFIX) && !names.has(key.slice(CAPABILITY_PREFIX.length).replace(/\.description$/, ''))) {
      fail('capability', `"${key}" names no registered capability`);
    }
  }

  // Review hints: a translation identical to its most likely origin may simply not be translated yet.
  const origins: Record<string, string> = { 'zh-Hant': 'zh', ms: 'en' };
  for (const [lang, origin] of Object.entries(origins)) {
    const catalog = catalogs.get(lang);
    const base = catalogs.get(origin);
    if (!catalog || !base) continue;
    for (const [key, value] of Object.entries(catalog)) {
      if (value === base[key] && /[A-Za-z\u4e00-\u9fff]{4,}/.test(value.replace(/\{[^}]*\}/g, ''))) report.push(`${lang} = ${origin}\t${key}\t${value}`);
    }
  }
  return { problems, report };
}

const CAPABILITY_PREFIX = 'agent.capability.';

/**
 * Characters whose Simplified and Traditional forms are never interchangeable, paired in both
 * directions. Kept to the words this console actually uses, so the list stays a list of real
 * mistakes rather than a character-set guess.
 */
const SCRIPT_PAIRS = [
  ['设', '設'], ['凭', '憑'], ['额', '額'], ['网', '網'], ['钥', '鑰'], ['帐', '帳'], ['载', '載'],
  ['数', '數'], ['时', '時'], ['击', '擊'], ['试', '試'], ['访', '訪'], ['认', '認'], ['证', '證'],
  ['输', '輸'], ['缓', '緩'], ['务', '務'], ['员', '員'], ['询', '詢'], ['择', '擇'], ['删', '刪'],
  ['该', '該'], ['处', '處'], ['关', '關'], ['闭', '閉'], ['审', '審'], ['记', '記'], ['层', '層'],
  ['导', '導'], ['与', '與'], ['个', '個'], ['为', '為'], ['从', '從'], ['变', '變'], ['发', '發'],
  ['后', '後'], ['们', '們'], ['这', '這'], ['来', '來'], ['对', '對'], ['开', '開'], ['进', '進'],
  ['条', '條'], ['请', '請'], ['页', '頁'], ['项', '項'], ['备', '備'], ['总', '總'], ['统', '統'],
  ['计', '計'], ['费', '費'], ['价', '價'], ['权', '權'], ['户', '戶'], ['应', '應'], ['态', '態'],
  ['选', '選'], ['类', '類'], ['单', '單'], ['带', '帶'], ['库', '庫'], ['环', '環'], ['转', '轉'],
  ['无', '無'], ['确', '確'], ['仅', '僅'], ['让', '讓'], ['够', '夠'], ['体', '體'], ['现', '現'],
  ['间', '間'], ['问', '問'], ['题', '題'], ['点', '點'], ['线', '線'], ['组', '組'], ['织', '織'],
  ['节', '節'], ['检', '檢'], ['测', '測'], ['验', '驗'], ['据', '據'], ['录', '錄'], ['标', '標'],
  ['识', '識'], ['别', '別'],
] as const;
const SIMPLIFIED_ONLY = SCRIPT_PAIRS.map(([simplified]) => simplified).join('');
const TRADITIONAL_ONLY = SCRIPT_PAIRS.map(([, traditional]) => traditional).join('');


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, report } = await checkCatalogs();
  for (const problem of problems) console.error(`${problem.kind.toUpperCase()}: ${problem.message}`);
  if (process.argv.includes('--report')) for (const line of report) console.log(line);
  console.log(problems.length === 0 ? `i18n: ${LANGUAGES.length} languages consistent` : `i18n: ${problems.length} problems`);
  if (problems.length > 0) process.exitCode = 1;
}
