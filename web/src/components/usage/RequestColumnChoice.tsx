import React from 'react';

import { Checkbox } from '../ui/checkbox';
import { ReorderHandle, useReorderRow } from '../common/RowReorder';
import type { RequestColumnDefinition } from './requestColumns';

interface RequestColumnChoiceProps {
  column: RequestColumnDefinition;
  label: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** One sortable column preference: selecting and dragging have separate targets. */
export const RequestColumnChoice = React.memo(function RequestColumnChoice({
  column,
  label,
  checked,
  disabled,
  onCheckedChange,
}: RequestColumnChoiceProps) {
  const { row, handle } = useReorderRow(column.id);

  return (
    <div
      ref={row.ref}
      style={row.style}
      data-reorder-key={row['data-reorder-key']}
      data-dragging={row['data-dragging']}
      className="req-column-choice-row"
    >
      <Checkbox
        className="req-column-choice"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      >
        {label}
      </Checkbox>
      <ReorderHandle
        {...handle}
        name={label}
        variant="inline"
        className="req-column-order-handle"
      />
    </div>
  );
});
