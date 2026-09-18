/**
 * The console's one copy path.
 *
 * `navigator.clipboard` is defined only in a secure context, and a plain-HTTP
 * origin is a first-class deployment of this console: `deploy/nginx.conf` listens
 * on :80 without TLS, the Vite dev server binds 0.0.0.0 so a LAN or Tailscale
 * device can reach it, and `OMCPA_BIND` may publish the container on a LAN
 * address. On every one of those the Clipboard API is simply `undefined`, so a
 * copy that knew only that API failed on all of them - which is what made every
 * copy control in the console fail at once.
 *
 * The selection-based path below is therefore not a legacy courtesy: on those
 * origins it is the only route there is, and it is also where a real rejection
 * from the modern API lands (`NotAllowedError` from an unfocused document or a
 * denied permission). It has to run synchronously, inside the click's transient
 * activation - hence the ordering in `copyText`, which reaches it without having
 * awaited anything whenever the modern API is absent.
 */

const COPY_SCRATCH_ATTRIBUTE = 'data-omc-copy-scratch';

/**
 * legacyCopy moves the text through a scratch element and the document selection.
 *
 * The element is positioned off-screen rather than hidden: `display: none` and
 * `visibility: hidden` both make a node unselectable, which leaves `execCommand`
 * with nothing to copy. Focus and selection are restored afterwards because the
 * caller is usually a row or a button the operator is still working in, and
 * stealing their caret to copy one field would be a worse outcome than the copy.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;

  // Read through the element's own interface rather than narrowing by class: the
  // focused node may be an `HTMLElement` or an `SVGElement`, and this module is
  // also exercised where the document is a stub.
  const activeElement = document.activeElement as { focus: () => void } | null;
  const previousFocus = activeElement && typeof activeElement.focus === 'function' ? activeElement : null;
  const selection = document.getSelection();
  const previousRanges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      previousRanges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const scratch = document.createElement('textarea');
  scratch.setAttribute(COPY_SCRATCH_ATTRIBUTE, '');
  scratch.setAttribute('readonly', '');
  scratch.setAttribute('aria-hidden', 'true');
  scratch.tabIndex = -1;
  scratch.value = text;
  scratch.style.position = 'fixed';
  scratch.style.top = '0';
  scratch.style.left = '-9999px';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);

  let copied = false;
  try {
    scratch.focus();
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    // Best-effort throughout: a restore that fails is not a failed copy, and letting
    // it escape would reject `copyText` and leave the caller with no result to report
    // - the silent-failure shape this module exists to remove.
    try {
      scratch.remove();
      if (previousFocus) previousFocus.focus();
      if (selection) {
        selection.removeAllRanges();
        for (const range of previousRanges) selection.addRange(range);
      }
    } catch {
      // The text is already on the clipboard; only the caret came back short.
    }
  }
  return copied;
}

/**
 * copyText reports whether the text actually reached the clipboard.
 *
 * The boolean is the point: several controls used to announce success without
 * reading the outcome, so a failed copy was indistinguishable from a working one.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall through: the modern API exists but refused (no focus, denied
      // permission), and the selection path often still succeeds.
    }
  }
  return legacyCopy(text);
}
