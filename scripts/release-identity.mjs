import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A tag is mutable. Resolve annotated tags to their commit at each publication boundary.
export function assertReleaseIdentity({ tag, revision, repository, head, resolve }) {
  assert.match(tag ?? '', /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.match(revision ?? '', /^[a-f0-9]{40}$/);
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/);
  assert.equal(head, revision, 'Publication checkout differs from the verified revision');
  let object = resolve(`repos/${repository}/git/ref/tags/${tag}`).object;
  const seen = new Set();
  while (object.type === 'tag') {
    assert.ok(!seen.has(object.sha), 'Cyclic tag identity');
    seen.add(object.sha);
    assert.ok(seen.size <= 8, 'Tag indirection is excessive');
    object = resolve(`repos/${repository}/git/tags/${object.sha}`).object;
  }
  assert.equal(object.type, 'commit');
  assert.equal(object.sha, revision, 'Release tag moved after verification');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertReleaseIdentity({
    tag: process.env.RELEASE_TAG, revision: process.env.RELEASE_REVISION,
    repository: process.env.GITHUB_REPOSITORY,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    resolve: endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 30_000 })),
  });
  console.log('Release tag and checkout match the verified commit.');
}
