import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogBackdrop = DialogPrimitive.Backdrop;
const DialogViewport = DialogPrimitive.Viewport;
const DialogPopup = DialogPrimitive.Popup;
const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;
const DialogClose = DialogPrimitive.Close;

const OPEN_OVERLAY_SELECTOR =
  '[data-slot="dialog-content"][data-open], [data-slot="alert-dialog-content"][data-open], [data-slot="sheet-content"][data-open]';

export function effectiveOverlayZIndex(element: Element | null): number {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const parsed = Number.parseInt(window.getComputedStyle(current).zIndex, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Whether a higher-stacked modal, alert-dialog, or sheet is currently open above `ownZIndex`.
 * Sibling portals (e.g. root-mounted AlertDialog or sibling AppModal above an AppDrawer) sit outside
 * Base UI's nested-dialog tree, so outer overlays check this before dismissing on Escape/outside-press.
 */
export function hasHigherOpenOverlay(ownZIndex: number, ownElement?: Element | null): boolean {
  const overlays = document.querySelectorAll(OPEN_OVERLAY_SELECTOR);
  for (const overlay of overlays) {
    if (overlay === ownElement) continue;
    if (effectiveOverlayZIndex(overlay) > ownZIndex) return true;
  }
  return false;
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogBackdrop,
  DialogViewport,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogPrimitive,
};
