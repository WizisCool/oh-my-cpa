import assert from 'node:assert/strict';
import test from 'node:test';
import { hasDeferredFontShards, hasReadmeScreenshotContent } from './readme-screenshot-readiness.mjs';

const CONTENT_SELECTOR = '.screenshot-content';
const TOAST_SELECTOR = '.omc-toast, .ant-message-notice';
const visible = () => ({ getClientRects: () => [{}] });

test('README captures require visible content, completed loading and detached toasts', () => {
  const originalDocument = globalThis.document;
  let content;
  let loading = [];
  let toast;
  globalThis.document = {
    querySelector: (selector) => {
      if (selector === CONTENT_SELECTOR) return content;
      if (selector === TOAST_SELECTOR) return toast;
      throw new Error(`unexpected selector: ${selector}`);
    },
    querySelectorAll: () => loading,
  };
  try {
    assert.equal(hasReadmeScreenshotContent(CONTENT_SELECTOR), false, 'a mounted shell is not ready');
    content = { getClientRects: () => [] };
    assert.equal(hasReadmeScreenshotContent(CONTENT_SELECTOR), false, 'hidden content is not ready');
    content = visible();
    assert.equal(hasReadmeScreenshotContent(CONTENT_SELECTOR), true);
    loading = [visible()];
    assert.equal(hasReadmeScreenshotContent(CONTENT_SELECTOR), false, 'loading still blocks capture');
    loading = [{ getClientRects: () => [] }];
    assert.equal(hasReadmeScreenshotContent(CONTENT_SELECTOR), true, 'hidden loading does not block capture');
    for (const tone of ['info', 'success', 'warning', 'error', 'pending']) {
      toast = { ...visible(), className: `omc-toast omc-toast-${tone}` };
      assert.equal(hasReadmeScreenshotContent(CONTENT_SELECTOR), false, `${tone} feedback blocks capture`);
    }
    toast = { getClientRects: () => [] };
    assert.equal(hasReadmeScreenshotContent(CONTENT_SELECTOR), false, 'exit motion blocks capture until detachment');
    toast = undefined;
    assert.equal(hasReadmeScreenshotContent(CONTENT_SELECTOR), true, 'capture resumes after feedback detaches');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('README captures wait until the console font registers more than its two core faces', () => {
  const originalDocument = globalThis.document;
  const faces = [{ family: '"Sarasa Mono SC"' }, { family: 'Sarasa Mono SC' }, { family: 'codicon' }];
  globalThis.document = { fonts: faces };
  try {
    assert.equal(hasDeferredFontShards(), false);
    faces.push({ family: 'Sarasa Mono SC' });
    assert.equal(hasDeferredFontShards(), true);
  } finally {
    globalThis.document = originalDocument;
  }
});
