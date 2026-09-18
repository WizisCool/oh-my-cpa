/**
 * The console's copy strategy, minus the browser.
 *
 * The defect these assertions exist for: every copy control called
 * `navigator.clipboard.writeText` directly, and that API is defined only in a
 * secure context. Served over plain HTTP - this repository's own nginx template
 * listens on :80, and the dev server is reachable from a LAN or Tailscale device -
 * the property is `undefined`, so every copy in the console failed at once.
 *
 * What can only be asserted here is the decision: which route is taken, in what
 * order, and whether the caller is told the truth. That the selection path works
 * in a real browser is not a claim this file makes; it is verified end to end
 * where a real document exists.
 *
 * The scratch element is observed through `document.createElement`, because the
 * route taken is the whole point - a test that only read the boolean could not
 * tell "the modern API worked" from "the fallback rescued it".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyText } from '../web/src/utils/clipboard.ts';

interface FakeRange {
  cloneRange: () => FakeRange;
}

interface FakeScratchElement {
  value: string;
  style: Record<string, string>;
  tabIndex: number;
  focus: () => void;
  select: () => void;
  setSelectionRange: (start: number, end: number) => void;
  setAttribute: (name: string, value: string) => void;
  remove: () => void;
}

interface ClipboardRoute {
  createdScratchElements: FakeScratchElement[];
  focusedLabels: string[];
  restoredRanges: number;
  removedScratchElements: number;
}

interface DomOptions {
  /** Absent means the origin is not secure: `navigator.clipboard` is simply not there. */
  writeText?: (text: string) => Promise<void>;
  execCommand?: () => boolean;
  focusedElementLabel?: string;
  /** Makes the caret restore itself fail, as a range whose node has gone would. */
  restoreThrows?: boolean;
}

/**
 * installDom replaces the globals `copyText` reads and records the route it took.
 */
function installDom(options: DomOptions): { route: ClipboardRoute; restore: () => void } {
  const route: ClipboardRoute = {
    createdScratchElements: [],
    focusedLabels: [],
    restoredRanges: 0,
    removedScratchElements: 0,
  };
  const originalDocument = globalThis.document;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  const document = {
    body: { appendChild: (element: FakeScratchElement) => element },
    activeElement: {
      focus: () => {
        if (options.restoreThrows) throw new Error('the range is no longer in the document');
        route.focusedLabels.push(options.focusedElementLabel ?? 'the previous element');
      },
    },
    createElement: (): FakeScratchElement => {
      const element: FakeScratchElement = {
        value: '',
        style: {},
        tabIndex: 0,
        focus: () => undefined,
        select: () => undefined,
        setSelectionRange: () => undefined,
        setAttribute: () => undefined,
        remove: () => {
          route.removedScratchElements += 1;
        },
      };
      route.createdScratchElements.push(element);
      return element;
    },
    execCommand: (command: string) => {
      assert.equal(command, 'copy');
      return options.execCommand ? options.execCommand() : false;
    },
    getSelection: () => ({
      rangeCount: 1,
      getRangeAt: () => ({ cloneRange: () => ({ cloneRange: () => ({}) as FakeRange }) as FakeRange }),
      addRange: () => {
        if (options.restoreThrows) throw new Error('the range is no longer in the document');
        route.restoredRanges += 1;
      },
      removeAllRanges: () => undefined,
    }),
  };

  Object.assign(globalThis, { document });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: options.writeText ? { clipboard: { writeText: options.writeText } } : {},
  });

  return {
    // The route is read by the assertions after the call, so the live object is
    // handed back rather than a copy that would freeze at install time.
    route,
    restore: () => {
      if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
      else globalThis.document = originalDocument;
      if (originalNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator');
      else Object.defineProperty(globalThis, 'navigator', originalNavigator);
    },
  };
}

const GATEWAY_KEY = 'sk-cpa-00000000000000000000000000000000';

test('the Clipboard API carries the copy when it is available', async () => {
  const written: string[] = [];
  const { route, restore } = installDom({ writeText: async (text) => void written.push(text) });
  try {
    assert.equal(await copyText(GATEWAY_KEY), true);
    assert.deepEqual(written, [GATEWAY_KEY]);
    assert.equal(route.createdScratchElements.length, 0, 'the scratch element stays unused when the API works');
  } finally {
    restore();
  }
});

test('a non-secure origin still copies, through the selection path', async () => {
  // `navigator.clipboard` is undefined over plain HTTP: this is the exact shape of
  // the reported failure, and it must not end in a failure toast.
  const { route, restore } = installDom({ execCommand: () => true });
  try {
    assert.equal(await copyText('endpoint-value'), true);
    assert.equal(route.createdScratchElements.length, 1, 'the selection path ran');
    assert.equal(route.createdScratchElements[0].value, 'endpoint-value');
    assert.equal(route.removedScratchElements, 1, 'the scratch element is cleaned up');
  } finally {
    restore();
  }
});

test('a refused Clipboard API falls back rather than reporting failure', async () => {
  const refusal = new Error('Write permission denied.');
  refusal.name = 'NotAllowedError';
  const { route, restore } = installDom({
    writeText: () => Promise.reject(refusal),
    execCommand: () => true,
  });
  try {
    assert.equal(await copyText('fallback-value'), true);
    assert.equal(route.createdScratchElements.length, 1);
  } finally {
    restore();
  }
});

test('both routes failing is reported as failure, never as success', async () => {
  const { route, restore } = installDom({ execCommand: () => false });
  try {
    assert.equal(await copyText('unreachable'), false);
    assert.equal(route.createdScratchElements.length, 1);
  } finally {
    restore();
  }
});

test('a throwing selection path is contained and reported as failure', async () => {
  const { route, restore } = installDom({
    execCommand: () => {
      throw new Error('copy is not allowed here');
    },
  });
  try {
    assert.equal(await copyText('contained'), false);
    assert.equal(route.removedScratchElements, 1);
  } finally {
    restore();
  }
});

test('the operator keeps their focus and selection', async () => {
  // The focus is usually a row or a button the operator is still working in.
  const { route, restore } = installDom({
    execCommand: () => true,
    focusedElementLabel: 'the row they came from',
  });
  try {
    assert.equal(await copyText('value'), true);
    assert.deepEqual(route.focusedLabels, ['the row they came from']);
    assert.equal(route.restoredRanges, 1);
  } finally {
    restore();
  }
});

test('a caret that cannot be restored does not hide the copy', async () => {
  // The restore only serves the operator's next keystroke. A failure there must not
  // reject the call, because a caller reporting a failure it did not have is the
  // defect this module exists to remove.
  const { route, restore } = installDom({ execCommand: () => true, restoreThrows: true });
  try {
    assert.equal(await copyText('value'), true);
    assert.equal(route.removedScratchElements, 1);
  } finally {
    restore();
  }
});