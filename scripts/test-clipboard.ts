/**
 * The console's copy strategy, minus the browser.
 *
 * The defect these assertions exist for: every copy control called
 * `navigator.clipboard.writeText` directly, and that API is defined only in a
 * secure context. Served over plain HTTP - this repository's own nginx template
 * listens on :80, and the dev server is reachable from a LAN or Tailscale device -
 * the property is `undefined`, so every copy in the console failed at once.
 *
 * The second defect, and the reason the fake document here models focus at all: a
 * dialog traps focus inside its own subtree, so a scratch element attached to
 * `document.body` selects nothing - and `execCommand('copy')` answers `true` for the
 * empty selection anyway. A copy inside the request detail drawer therefore reported
 * success while leaving the clipboard untouched.
 *
 * What can only be asserted here is the decision: which route is taken, where the
 * scratch element is attached, and whether the caller is told the truth. That the
 * selection path works in a real browser is not a claim this file makes; it is
 * verified end to end where a real document exists.
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
  selectionStart: number;
  selectionEnd: number;
  setAttribute: (name: string, value: string) => void;
  focus: () => void;
  select: () => void;
  setSelectionRange: (start: number, end: number) => void;
  remove: () => void;
}

interface ClipboardRoute {
  createdScratchElements: FakeScratchElement[];
  appendedToBody: FakeScratchElement[];
  appendedToDialog: FakeScratchElement[];
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
  /**
   * Where the focused element's dialog sits. `ancestor` is what a focused control
   * inside a dialog reports; `enclosing` is antd's Drawer, which parks focus on the
   * drawer root that *holds* the role-bearing element rather than being one - the
   * exact shape the request detail drawer presents.
   */
  dialog?: 'ancestor' | 'enclosing';
  /** Takes focus and the selection back, as a dialog's focus trap does. */
  focusTrap?: boolean;
  /**
   * Focus sits on the body while a closed dialog is still in the DOM, which is what
   * antd leaves behind: it portals dialogs to the body and keeps them after closing.
   */
  focusOnBody?: boolean;
}

/**
 * installDom replaces the globals `copyText` reads and records the route it took.
 *
 * Focus and selection are modelled as one piece of state rather than two, because
 * that is the behaviour under test: a selection only exists where focus is, which is
 * precisely why losing focus to a focus trap leaves an empty selection behind.
 */
function installDom(options: DomOptions): { route: ClipboardRoute; restore: () => void } {
  const route: ClipboardRoute = {
    createdScratchElements: [],
    appendedToBody: [],
    appendedToDialog: [],
    focusedLabels: [],
    restoredRanges: 0,
    removedScratchElements: 0,
  };
  const originalDocument = globalThis.document;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  const dialog = {
    appendChild: (element: FakeScratchElement) => {
      route.appendedToDialog.push(element);
      return element;
    },
  };
  const body = {
    appendChild: (element: FakeScratchElement) => {
      route.appendedToBody.push(element);
      return element;
    },
    // A closed dialog stays inside the body, so a search from the body finds one.
    closest: () => null,
    querySelector: () => dialog,
  };
  /** The node a focus trap parks focus on when it takes focus back. */
  const trapTarget = { tagName: 'BUTTON' };

  const state = {
    activeElement: undefined as unknown,
    selectionAnchor: null as unknown,
  };

  const focusedElement = {
    focus: () => {
      if (options.focusTrap) {
        state.activeElement = trapTarget;
        state.selectionAnchor = trapTarget;
        return;
      }
      state.activeElement = focusedElement;
      route.focusedLabels.push(options.focusedElementLabel ?? 'the previous element');
    },
    // antd's Drawer parks focus on the drawer root: it contains the role-bearing
    // element rather than sitting inside one.
    closest: () => (options.dialog === 'ancestor' ? dialog : null),
    querySelector: () => (options.dialog === 'enclosing' ? dialog : null),
  };
  state.activeElement = options.focusOnBody ? body : focusedElement;

  const document = {
    body,
    get activeElement() {
      return state.activeElement;
    },
    createElement: (): FakeScratchElement => {
      const element: FakeScratchElement = {
        value: '',
        style: {},
        tabIndex: 0,
        selectionStart: 0,
        selectionEnd: 0,
        setAttribute: () => undefined,
        // A focus trap intercepts focus synchronously, which is why the scratch
        // element never sees it: the trap's target is already focused when
        // `focus()` returns.
        focus: () => {
          state.activeElement = options.focusTrap ? trapTarget : element;
        },
        select: () => {
          element.selectionStart = 0;
          element.selectionEnd = element.value.length;
        },
        setSelectionRange: (start: number, end: number) => {
          element.selectionStart = start;
          element.selectionEnd = end;
        },
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
      get anchorNode() {
        return state.selectionAnchor;
      },
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
    assert.equal(route.appendedToBody.length, 1, 'the scratch element joins the document outside a dialog');
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

test('the scratch element joins the dialog that contains the focused control', async () => {
  // A dialog traps focus to its own subtree. The scratch element has to be inside it
  // or the selection it relies on never materialises.
  const { route, restore } = installDom({ execCommand: () => true, dialog: 'ancestor' });
  try {
    assert.equal(await copyText('inside-a-dialog'), true);
    assert.equal(route.appendedToDialog.length, 1);
    assert.equal(route.appendedToBody.length, 0);
  } finally {
    restore();
  }
});

test('the scratch element joins a dialog that only contains the focused root', async () => {
  // antd's Drawer parks focus on the drawer root, which holds the role-bearing
  // element rather than being inside one. This is the request detail drawer's shape,
  // and searching only upwards leaves the copy selecting nothing.
  const { route, restore } = installDom({ execCommand: () => true, dialog: 'enclosing' });
  try {
    assert.equal(await copyText('inside-the-drawer-root'), true);
    assert.equal(route.appendedToDialog.length, 1);
    assert.equal(route.appendedToBody.length, 0);
  } finally {
    restore();
  }
});

test('a closed dialog left in the body does not capture the scratch element', async () => {
  // antd portals dialogs to the body and keeps them after closing, so a search from a
  // document-level focus finds a hidden subtree. Attaching there would lose copies that
  // work today, which is why document-level focus goes straight to the body.
  const { route, restore } = installDom({ execCommand: () => true, focusOnBody: true });
  try {
    assert.equal(await copyText('plain-page-value'), true);
    assert.equal(route.appendedToBody.length, 1);
    assert.equal(route.appendedToDialog.length, 0);
  } finally {
    restore();
  }
});

test('an empty value is not reported as a copied one', async () => {
  // Measured rather than assumed: `execCommand('copy')` answers `true` for an empty
  // value while leaving the clipboard exactly as it was, and the range check is
  // vacuous at length zero. Nothing reached the clipboard, so nothing may be claimed.
  const { route, restore } = installDom({ execCommand: () => true });
  try {
    assert.equal(await copyText(''), false);
    assert.equal(route.removedScratchElements, 1, 'the scratch element is still cleaned up');
  } finally {
    restore();
  }
});

test('a focus trap that takes the focus is reported as failure, not success', async () => {
  // The reported defect: `execCommand('copy')` answers `true` for an empty selection,
  // so a copy the trap silently defeated still announced itself as a success. Whether
  // the scratch element holds focus is what decides.
  const { route, restore } = installDom({ execCommand: () => true, focusTrap: true });
  try {
    assert.equal(await copyText('never-selected'), false);
    assert.equal(route.removedScratchElements, 1, 'the scratch element is still cleaned up');
  } finally {
    restore();
  }
});