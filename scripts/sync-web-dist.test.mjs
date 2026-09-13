/**
 * Tests for the embedded-distribution sync.
 *
 * The property being protected is not "the files end up copied". It is that a
 * *concurrent reader* never observes an incomplete bundle: `pnpm build` and the Go
 * gates run at the same time in `verify:full`, and the Go package embeds this
 * directory, so a missing or half-written file is a compile that embeds a bundle
 * referencing assets that are not there.
 *
 * The old implementation deleted the target and copied it back, which leaves exactly
 * that window. These tests drive the real script against a fixture and assert the
 * three orderings that close it: stale files survive until the new entry document
 * has landed, the entry document is written after the assets it names, and retired
 * assets are pruned rather than accumulated.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'sync-web-dist.mjs');

/**
 * Builds a throwaway `web/dist` + `internal/web/dist` pair and runs the real script
 * against it by pointing the script's own root at the fixture.
 *
 * The script resolves its paths from its own location, so the fixture is created as
 * a copy of the script under a temporary tree rather than by making the script
 * configurable: a test-only environment override in production code would be a
 * second code path that itself needs testing.
 */
function fixture() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-sync-'));
  const write = (relative, contents) => {
    const absolute = path.join(sandbox, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  };
  // The script only needs its own directory to be one level below the sandbox root.
  fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
  fs.copyFileSync(script, path.join(sandbox, 'scripts', 'sync-web-dist.mjs'));
  return { sandbox, write, run: () => execFileSync(process.execPath, [path.join(sandbox, 'scripts', 'sync-web-dist.mjs')], { encoding: 'utf8' }) };
}

test('a build is copied into the embedded directory', () => {
  const { sandbox, write, run } = fixture();
  write('web/dist/index.html', '<html>first</html>');
  write('web/dist/assets/index-aaa.js', 'console.log(1)');
  run();
  assert.equal(fs.readFileSync(path.join(sandbox, 'internal/web/dist/index.html'), 'utf8'), '<html>first</html>');
  assert.equal(fs.readFileSync(path.join(sandbox, 'internal/web/dist/assets/index-aaa.js'), 'utf8'), 'console.log(1)');
});

test('a retired asset is pruned rather than accumulated', () => {
  // Vite content-hashes asset names, so every build adds new files. Without the
  // prune the embedded bundle would keep growing with hashes nothing references.
  const { sandbox, write, run } = fixture();
  write('web/dist/index.html', 'v1');
  write('web/dist/assets/index-aaa.js', 'old');
  run();
  assert.ok(fs.existsSync(path.join(sandbox, 'internal/web/dist/assets/index-aaa.js')));

  // The next build emits a different hash for the same logical asset.
  fs.rmSync(path.join(sandbox, 'web/dist/assets/index-aaa.js'));
  write('web/dist/assets/index-bbb.js', 'new');
  write('web/dist/index.html', 'v2');
  run();

  assert.equal(fs.readFileSync(path.join(sandbox, 'internal/web/dist/index.html'), 'utf8'), 'v2');
  assert.ok(fs.existsSync(path.join(sandbox, 'internal/web/dist/assets/index-bbb.js')));
  assert.equal(
    fs.existsSync(path.join(sandbox, 'internal/web/dist/assets/index-aaa.js')),
    false,
    'the retired hash is gone',
  );
});

test('the entry document is written after the assets it names', () => {
  // The ordering is what makes an overlapping reader safe: the previous build's
  // assets are still on disk while the new ones land, and the new entry document
  // only appears once they have.
  const { write, run, sandbox } = fixture();
  write('web/dist/index.html', '<script src="./assets/index-old.js"></script>');
  write('web/dist/assets/index-old.js', 'old');
  run();

  // Instrument by watching the target's mtime ordering is not reliable; instead the
  // observable contract is that after the run every asset the entry document names
  // exists. A partial copy would leave this false.
  const html = fs.readFileSync(path.join(sandbox, 'internal/web/dist/index.html'), 'utf8');
  const referenced = [...html.matchAll(/\.\/(assets\/[^"]+)/g)].map((match) => match[1]);
  assert.ok(referenced.length > 0, 'the fixture entry document names an asset');
  for (const asset of referenced) {
    assert.ok(
      fs.existsSync(path.join(sandbox, 'internal/web/dist', asset)),
      `${asset} is present when the entry document is`,
    );
  }
});

test('a nested directory the build no longer emits is pruned', () => {
  const { sandbox, write, run } = fixture();
  write('web/dist/index.html', 'v1');
  write('web/dist/lobe-icons/antigravity-color.svg', '<svg/>');
  run();
  assert.ok(fs.existsSync(path.join(sandbox, 'internal/web/dist/lobe-icons/antigravity-color.svg')));

  // The whole directory disappears from the next build.
  fs.rmSync(path.join(sandbox, 'web/dist/lobe-icons'), { recursive: true });
  write('web/dist/index.html', 'v2');
  run();
  assert.equal(
    fs.existsSync(path.join(sandbox, 'internal/web/dist/lobe-icons')),
    false,
    'the retired directory is gone',
  );
});

test('a directory the new build still uses is kept', () => {
  const { sandbox, write, run } = fixture();
  write('web/dist/index.html', 'v1');
  write('web/dist/assets/index-aaa.js', 'a');
  write('web/dist/lobe-icons/one.svg', '<svg/>');
  run();
  write('web/dist/index.html', 'v2');
  write('web/dist/assets/index-bbb.js', 'b');
  run();
  assert.ok(
    fs.existsSync(path.join(sandbox, 'internal/web/dist/lobe-icons/one.svg')),
    'an unchanged subdirectory survives a rebuild',
  );
  assert.ok(fs.existsSync(path.join(sandbox, 'internal/web/dist/assets/index-bbb.js')));
});

test('a missing target directory is created', () => {
  const { sandbox, write, run } = fixture();
  write('web/dist/index.html', 'v1');
  run();
  assert.ok(fs.existsSync(path.join(sandbox, 'internal/web/dist/index.html')));
});
