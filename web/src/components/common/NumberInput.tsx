import React from 'react';
import { InputNumber, type InputNumberProps } from 'antd';
import { useWheelStep } from '../../hooks/useWheelStep';

type InputNumberRef = React.ComponentRef<typeof InputNumber>;

/**
 * The console's number field. Once the caret is in it, the wheel steps it, so a value can be nudged
 * without aiming at the small step arrows; a wheel that only passes over the field on its way down
 * a page leaves both the value and the caret alone.
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
  // A step is the reader's own act, so only a field holding the caret takes the wheel. Stepping one
  // on hover changed a value being scrolled past, and the step itself takes the caret (the field
  // focuses the input after it), which is how a scroll could open a field nobody had clicked.
  const focusedInput = () => {
    const input = editableInput();
    return input?.matches(':focus') ? input : null;
  };
  useWheelStep(root, (isUp) => {
    const input = focusedInput();
    if (!input) return;
    const key = isUp ? 'ArrowUp' : 'ArrowDown';
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }, !props.disabled && !props.readOnly && props.keyboard !== false, () => focusedInput() !== null);
  return <InputNumber<T> ref={attach} {...props} />;
}

export const NumberInput = React.forwardRef(NumberInputWithRef) as <T extends number | string = number>(
  props: InputNumberProps<T> & React.RefAttributes<InputNumberRef>,
) => React.ReactElement;
