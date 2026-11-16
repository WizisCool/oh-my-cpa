import React from 'react';
import { Input, type InputProps } from '@/components/ui/input';
import { Textarea, type TextareaProps } from '@/components/ui/textarea';

function isComposing(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): boolean {
  return (event.nativeEvent as InputEvent | undefined)?.isComposing === true;
}

function useComposingField<E extends HTMLInputElement | HTMLTextAreaElement>(
  value: string,
  onCommit: (value: string) => void,
  onBlur?: React.FocusEventHandler<E>,
) {
  const [composingDraft, setComposingDraft] = React.useState<string | null>(null);
  const isComposingSessionRef = React.useRef(false);
  const lastCommittedRef = React.useRef<string>(value);

  React.useEffect(() => {
    lastCommittedRef.current = value;
    if (!isComposingSessionRef.current) {
      setComposingDraft(null);
    }
  }, [value]);

  const commit = React.useCallback(
    (text: string) => {
      isComposingSessionRef.current = false;
      setComposingDraft(null);
      if (text === lastCommittedRef.current) return;
      lastCommittedRef.current = text;
      onCommit(text);
    },
    [onCommit],
  );

  const { displayValue, ...handlers } = {
    displayValue: composingDraft ?? value,
    onChange: (event: React.ChangeEvent<E>) => {
      if (isComposing(event)) {
        isComposingSessionRef.current = true;
        setComposingDraft(event.target.value);
        return;
      }
      commit(event.target.value);
    },
    onCompositionStart: () => {
      isComposingSessionRef.current = true;
      setComposingDraft((prev) => prev ?? value);
    },
    onCompositionEnd: (event: React.CompositionEvent<E>) => commit(event.currentTarget.value),
    onBlur: (event: React.FocusEvent<E>) => {
      if (composingDraft !== null) commit(event.currentTarget.value);
      else isComposingSessionRef.current = false;
      onBlur?.(event);
    },
  };
  return { value: displayValue, ...handlers };
}

export interface ComposingTextInputProps extends Omit<InputProps, 'value' | 'onChange'> {
  value: string;
  onCommit: (value: string) => void;
  'data-testid'?: string;
}

/**
 * Input wrapper that keeps IME composition text local until `compositionEnd`
 * so background draft rebases never clobber an active composition session.
 */
export const ComposingTextInput: React.FC<ComposingTextInputProps> = ({ value, onCommit, onBlur, ...rest }) => {
  const fieldProps = useComposingField<HTMLInputElement>(value, onCommit, onBlur);
  return <Input {...rest} {...fieldProps} />;
};

export interface ComposingTextareaProps extends Omit<TextareaProps, 'value' | 'onChange'> {
  value: string;
  onCommit: (value: string) => void;
  'data-testid'?: string;
}

/**
 * Multiline textarea wrapper preserving literal newlines and local IME
 * composition state across background draft rebases.
 */
export const ComposingTextarea: React.FC<ComposingTextareaProps> = ({ value, onCommit, onBlur, ...rest }) => {
  const fieldProps = useComposingField<HTMLTextAreaElement>(value, onCommit, onBlur);
  return <Textarea {...rest} {...fieldProps} />;
};
