import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./test-logic.mjs', import.meta.url));

test('logic files option rejects missing or malformed JSON operands with a flag-specific diagnostic', () => {
  for (const flags of [['--files'], ['--files', '--plan'], ['--files', 'not-json'], ['--files', 'null'], ['--files', '[1]']]) {
    const result = spawnSync(process.execPath, [runner, ...flags], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, JSON.stringify(flags));
    assert.match(result.stderr, /--files requires a JSON path array/, JSON.stringify(flags));
    assert.doesNotMatch(result.stderr, /SyntaxError/);
    assert.doesNotMatch(result.stdout, /starting|selected|PASS/);
  }
});

test('logic planning accepts an explicit path array without executing suites', () => {
  const result = spawnSync(process.execPath, [runner, '--files', '[]', '--plan'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  const counts = result.stdout.match(/selected (\d+)\/(\d+) suites/);
  assert.ok(counts);
  assert.ok(Number(counts[1]) > 0);
  assert.equal(counts[1], counts[2], 'an empty change list conservatively selects every suite');
});
