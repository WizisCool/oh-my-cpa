import React from 'react';
import { Input, type InputProps } from '@/components/ui/input';

function isComposing(event: React.ChangeEvent<HTMLInputElement>): boolean {
  return (event.nativeEvent as InputEvent | undefined)?.isComposing === true;
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

  return (
    <Input
      {...rest}
      value={composingDraft ?? value}
      onChange={(event) => {
        if (isComposing(event)) {
          isComposingSessionRef.current = true;
          setComposingDraft(event.target.value);
          return;
        }
        commit(event.target.value);
      }}
      onCompositionStart={() => {
        isComposingSessionRef.current = true;
        setComposingDraft((prev) => prev ?? value);
      }}
      onCompositionEnd={(event) => commit(event.currentTarget.value)}
      onBlur={(event) => {
        if (composingDraft !== null) commit(event.currentTarget.value);
        else isComposingSessionRef.current = false;
        onBlur?.(event);
      }}
    />
  );
};
