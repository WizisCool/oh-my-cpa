import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = path.join(root, '.github', 'workflows', 'ci.yml');
const source = fs.readFileSync(workflow, 'utf8');
const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
if (document.errors.length > 0) {
  for (const error of document.errors) console.error(error.message);
  process.exitCode = 1;
} else {
  const value = document.toJS();
  if (!value.jobs?.verify?.steps?.length) throw new Error('CI workflow has no verify steps');
  console.log(`CI workflow parsed with ${value.jobs.verify.steps.length} verify steps.`);
}
