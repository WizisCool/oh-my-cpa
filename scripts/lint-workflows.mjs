import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { validateReleaseWorkflow } from './release-workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDirectory = path.join(root, '.github', 'workflows');
const version = '1.7.12';

export function runWorkflowLint(execute = execFileSync) {
  const goBin = path.join(execute('go', ['env', 'GOPATH'], { encoding: 'utf8', cwd: root }).trim(), 'bin', process.platform === 'win32' ? 'actionlint.exe' : 'actionlint');
  const binary = process.env.ACTIONLINT_BIN ?? goBin;
  const reported = execute(binary, ['-version'], { encoding: 'utf8' });
  if (!reported.startsWith('v' + version + '\n')) throw new Error(`actionlint must be ${version}; install github.com/rhysd/actionlint/cmd/actionlint@v${version}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-workflow-lint-'));
  try {
    const files = fs.readdirSync(workflowDirectory).filter(file => /\.ya?ml$/.test(file));
    for (const file of files) {
      const source = fs.readFileSync(path.join(workflowDirectory, file), 'utf8');
      const document = parseDocument(source, { uniqueKeys: true });
      if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('\n'));
      if (file === 'release.yml') {
        // GitHub's deployed queue:max predates support in the pinned actionlint schema.
        // Only this one validated extension is normalized; every shell/expression remains intact.
        validateReleaseWorkflow(document.toJS());
        document.deleteIn(['concurrency', 'queue']);
      }
      fs.writeFileSync(path.join(directory, file), document.toString({ lineWidth: 0 }));
    }
    execute(binary, ['-shellcheck=', ...files.map(file => path.join(directory, file))], { stdio: 'inherit' });
    console.log(`actionlint ${version}: ${files.length} workflows passed`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runWorkflowLint();
