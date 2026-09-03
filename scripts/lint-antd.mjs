import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'node_modules', '@ant-design', 'cli', 'dist', 'index.js');
const baselinePath = path.join(root, 'scripts', 'antd-lint-baseline.json');
const result = spawnSync(process.execPath, [executable, 'lint', 'web/src', '--format', 'json'], {
  cwd: root,
  encoding: 'utf8',
});
if (result.error) throw result.error;
if (!result.stdout.trim()) {
  process.stderr.write(result.stderr);
  throw new Error(`antd lint produced no JSON (exit ${result.status})`);
}
const report = JSON.parse(result.stdout);
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const relative = (file) => path.relative(root, file).split(path.sep).join('/');
const key = (issue) => `${relative(issue.file)} :: ${issue.rule} :: ${issue.message}`;
const allowed = new Map(Object.entries(baseline.issues));
const observed = new Map();
const newIssues = [];
for (const issue of report.issues) {
  const signature = key(issue);
  const count = (observed.get(signature) ?? 0) + 1;
  observed.set(signature, count);
  if (count > (allowed.get(signature) ?? 0)) newIssues.push(issue);
}

console.log(JSON.stringify(report.summary, null, 2));
if (report.partial || report.skippedFiles.length > 0) {
  console.error('Ant Design lint was partial or skipped files.');
  process.exitCode = 1;
}
if (newIssues.length > 0) {
  console.error('New Ant Design lint issues:');
  for (const issue of newIssues) {
    console.error(`${relative(issue.file)}:${issue.line} ${issue.rule} ${issue.message}`);
  }
  process.exitCode = 1;
}
