import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDirectory = path.join(root, '.github', 'workflows');
const actionDirectory = path.join(root, '.github', 'actions');
const version = '1.7.12';

/**
 * The supply-chain rules actionlint does not check: an action is pinned to a commit,
 * because a tag can be moved under a release, and a checkout does not leave its token
 * in the working tree for later steps to read.
 */
export function pinningProblems(file, workflow) {
  const problems = [];
  const jobs = workflow.runs?.using === 'composite' ? { composite: workflow.runs } : workflow.jobs ?? {};
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of [job, ...(job.steps ?? [])]) {
      if (!step.uses || step.uses.startsWith('./')) continue;
      if (!/@[a-f0-9]{40}$/.test(step.uses)) problems.push(`${file} ${jobName}: ${step.uses} is not pinned to a commit`);
      if (step.uses.startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) {
        problems.push(`${file} ${jobName}: checkout must set persist-credentials: false`);
      }
    }
  }
  // The release signing key signs what every installation trusts, so no job but the one
  // that signs the manifest may see it.
  for (const [jobName, job] of Object.entries(jobs)) {
    const isSigningJob = file === 'release.yml' && jobName === 'release';
    if (!isSigningJob && JSON.stringify(job).includes('secrets.RELEASE_SIGNING_KEY')) {
      problems.push(`${file} ${jobName}: only the release job may read RELEASE_SIGNING_KEY`);
    }
  }
  return problems;
}

export function runWorkflowLint(execute = execFileSync) {
  const goBin = path.join(execute('go', ['env', 'GOPATH'], { encoding: 'utf8', cwd: root }).trim(), 'bin', process.platform === 'win32' ? 'actionlint.exe' : 'actionlint');
  const binary = process.env.ACTIONLINT_BIN ?? goBin;
  const reported = execute(binary, ['-version'], { encoding: 'utf8' });
  if (!reported.startsWith('v' + version + '\n')) throw new Error(`actionlint must be ${version}; install github.com/rhysd/actionlint/cmd/actionlint@v${version}`);
  const files = fs.readdirSync(workflowDirectory).filter(file => /\.ya?ml$/.test(file));
  const documents = files.map(file => {
    const document = parseDocument(fs.readFileSync(path.join(workflowDirectory, file), 'utf8'), { uniqueKeys: true });
    if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('\n'));
    return { file, document };
  });
  const problems = documents.flatMap(({ file, document }) => pinningProblems(file, document.toJS()));
  // Moving setup into local composites must not create a gap in action pinning.
  for (const directory of fs.readdirSync(actionDirectory)) {
    for (const name of ['action.yml', 'action.yaml']) {
      const file = path.join(actionDirectory, directory, name);
      if (!fs.existsSync(file)) continue;
      const document = parseDocument(fs.readFileSync(file, 'utf8'), { uniqueKeys: true });
      if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('\n'));
      problems.push(...pinningProblems(file, document.toJS()));
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));
  for (const { file, document } of documents) {
    // Only the newer GitHub queue key is normalized for the pinned actionlint schema.
    // Preserve the actual filename so actionlint can resolve local action inputs.
    document.deleteIn(['concurrency', 'queue']);
    execute(binary, ['-shellcheck=', '-stdin-filename', path.join(workflowDirectory, file), '-'], {
      cwd: root, input: document.toString({ lineWidth: 0 }), stdio: ['pipe', 'inherit', 'inherit'],
    });
  }
  console.log(`actionlint ${version}: ${files.length} workflows and composite action pins passed`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runWorkflowLint();
