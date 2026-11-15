import type React from 'react';

/**
 * Whether a click on a row or card opens it, rather than landing on a control inside it. A reading
 * that only takes focus for its tooltip - a quota bar, the state - is not a control.
 */
export function isRecordBodyClick(event: React.MouseEvent<HTMLElement>): boolean {
  const target = event.target instanceof Element ? event.target : undefined;
  // A dialog opened from inside - a capacity estimate, a confirmation - is portalled elsewhere in the
  // page but still bubbles here; a click on it, or on its mask to close it, is not a click on the row.
  if (target && !event.currentTarget.contains(target)) return false;
  if (!target) return false;
  if (window.getSelection()?.toString()) return false;
  // A control's own hit box - the switch's - belongs to the control, not to the row around it.
  return !target.closest('button, a, input, label, [role="button"], [role="checkbox"], [role="switch"], [data-control-hit], [data-slot="dropdown-menu-content"], [data-slot="popover-content"]');
}
