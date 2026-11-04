import React from 'react';
import { InputNumber, type InputNumberProps } from 'antd';
import { useWheelStep } from '../../hooks/useWheelStep';

type InputNumberRef = React.ComponentRef<typeof InputNumber>;

/**
 * The console's number field. The wheel steps it while the pointer is over it, focused or not, so
 * a value can be nudged without clicking in or aiming at the small step arrows.
 *
 * A wheel step is handed to the field as an arrow key, which is the field's own step: it keeps the
 * field's `step`, bounds, precision and string mode, and reports the change through `onChange` as
 * typing an arrow would.
 */
function NumberInputWithRef<T extends number | string = number>(
  props: InputNumberProps<T>,
  ref: React.ForwardedRef<InputNumberRef>,
) {
  const [root, setRoot] = React.useState<HTMLElement | null>(null);
  const attach = React.useCallback((instance: InputNumberRef | null) => {
    setRoot(instance?.nativeElement ?? null);
    if (typeof ref === 'function') ref(instance);
    else if (ref) ref.current = instance;
  }, [ref]);
  // The rendered input is the authority on whether it can change: a surrounding `Form disabled`
  // disables it without touching this field's props.
  const editableInput = () => {
    const input = root?.querySelector('input');
    return input && !input.disabled && !input.readOnly ? input : null;
  };
  useWheelStep(root, (isUp) => {
    const input = editableInput();
    if (!input) return;
    const key = isUp ? 'ArrowUp' : 'ArrowDown';
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }, !props.disabled && !props.readOnly && props.keyboard !== false, () => editableInput() !== null);
  return <InputNumber<T> ref={attach} {...props} />;
}

export const NumberInput = React.forwardRef(NumberInputWithRef) as <T extends number | string = number>(
  props: InputNumberProps<T> & React.RefAttributes<InputNumberRef>,
) => React.ReactElement;
