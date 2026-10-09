import assert from 'node:assert/strict';
import test from 'node:test';
import { createID } from '../web/src/utils/ids';
import { extractThinking } from '../web/src/utils/thinking';
import { effectiveModel } from '../web/src/types/requestModel';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, readImage } from '../web/src/components/workspace/imageAttachments';

test('extractThinking parses inline <think> tags', () => {
  const inline = '<think>I need to solve X</think>The answer is 42';
  const extracted = extractThinking(inline);
  assert.equal(extracted.thought, 'I need to solve X');
  assert.equal(extracted.reply, 'The answer is 42');
  assert.equal(extracted.isThinking, false);

  const partial = '<think>Still thinking';
  const partialExtracted = extractThinking(partial);
  assert.equal(partialExtracted.thought, 'Still thinking');
  assert.equal(partialExtracted.reply, '');
  assert.equal(partialExtracted.isThinking, true);

  const normal = 'Direct answer';
  assert.equal(extractThinking(normal).thought, undefined);
  assert.equal(extractThinking(normal).reply, 'Direct answer');
  assert.equal(extractThinking(normal).isThinking, false);
});

test('conversation IDs do not require a secure-context randomUUID', () => {
  assert.equal(createID('turn', { randomUUID: () => 'native-id' }), 'native-id');
  const randomValuesID = createID('turn', { getRandomValues: bytes => bytes.fill(7) });
  assert.match(randomValuesID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const fallback = createID('turn', {});
  assert.match(fallback, /^turn-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
});

test('ID generation falls through throwing crypto APIs and keeps one monotone fallback', () => {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => 1000;
  Math.random = () => 0.5;
  try {
    const source = {randomUUID() { throw new Error('unavailable'); }, getRandomValues() { throw new Error('unavailable'); }};
    const first = createID('agent', source);
    const second = createID('playground', source);
    assert.match(first, /^agent-rs-[0-9a-z]+-i$/);
    assert.match(second, /^playground-rs-[0-9a-z]+-i$/);
    assert.equal(parseInt(second.split('-')[2], 36), parseInt(first.split('-')[2], 36) + 1);
    const fallbackUUID = createID('turn', {randomUUID() { throw new Error('unavailable'); }, getRandomValues(bytes) { bytes.fill(255); }});
    assert.equal(fallbackUUID, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
});

test('inline thinking preserves first-block parsing, streaming whitespace and Unicode', () => {
  assert.deepEqual(extractThinking('前缀 <think> 思考 </think> 答案'), {thought: '思考', reply: '前缀  答案', isThinking: false});
  assert.deepEqual(extractThinking('<think> </think>'), {thought: undefined, reply: '', isThinking: false});
  assert.deepEqual(extractThinking('<think>'), {thought: '', reply: '', isThinking: true});
  assert.deepEqual(extractThinking('<think>first</think><think>second</think>'), {thought: 'first', reply: '<think>second</think>', isThinking: false});
});

test('effective model retains the exact nonblank override and ignores other values', () => {
  for (const override of [undefined, null, 0, false, {}, [], '', '  ', '\n\t']) {
    assert.equal(effectiveModel({model: 'selected', custom_body: {model: override}}), 'selected');
  }
  assert.equal(effectiveModel({model: 'selected'}), 'selected');
  assert.equal(effectiveModel({model: 'selected', custom_body: {model: '  模型/2 \n'}}), '  模型/2 \n');
});

test('image admission retains MIME, size and magic-byte limits before decoding', async () => {
  assert.deepEqual(IMAGE_TYPES, ['image/png', 'image/jpeg', 'image/webp']);
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_IMAGES, 4);
  for (const file of [
    new File(['hello'], 'text.txt', {type: 'text/plain'}),
    new File([], 'empty.png', {type: 'image/png'}),
    new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'large.png', {type: 'image/png'}),
    new File(['not a PNG'], 'forged.png', {type: 'image/png'}),
    new File(['not a JPEG'], 'forged.jpg', {type: 'image/jpeg'}),
    new File(['RIFFnot-NOPE'], 'forged.webp', {type: 'image/webp'}),
  ]) await assert.rejects(readImage(file), {message: 'invalid_image'});
});
