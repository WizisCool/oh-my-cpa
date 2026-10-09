/** Navigation previews a choice; only Enter, Space or a click commits it. */
export function nextPickerIndex(key: string, current: number, count: number): number | null {
  if (count < 1) return null;
  const index = Math.max(0, Math.min(current, count - 1));
  switch (key) {
    case 'ArrowDown': return (index + 1) % count;
    case 'ArrowUp': return (index + count - 1) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** How close to a window edge the surface may come, and how far it stands off its trigger. */
export const PICKER_EDGE = 12;
export const PICKER_GAP = 6;
/** Enough for the head, a few rows and the key row; below this the other side is worth having. */
const PICKER_COMFORT = 280;

export interface PickerRoom {
  placement: 'topRight' | 'bottomRight';
  height: number;
}

/** Above the trigger unless that side is cramped and the other is roomier. */
export function pickerRoom(triggerTop: number, triggerBottom: number, viewportHeight: number): PickerRoom {
  const above = triggerTop - PICKER_EDGE - PICKER_GAP;
  const below = viewportHeight - triggerBottom - PICKER_EDGE - PICKER_GAP;
  return above >= PICKER_COMFORT || above >= below
    ? { placement: 'topRight', height: Math.max(0, above) }
    : { placement: 'bottomRight', height: Math.max(0, below) };
}
