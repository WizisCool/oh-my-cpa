import React from 'react';
import { Input } from '@/components/ui/input';
import { RenameOutlined } from '../icons';
import { useT } from '../../i18n';
import { Tooltip } from './Tooltip';
import styles from './InlineName.module.css';

export const inlineNameEditableClass = styles.editable;
export const inlineNamePersistentClass = styles.persistent;

interface RenameButtonProps {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  'data-testid'?: string;
}

export function RenameButton({ label, disabled, onClick, 'data-testid': testId }: RenameButtonProps) {
  const t = useT();
  return (
    <Tooltip title={t('af.rename')}>
      <button
        type="button"
        className={styles.rename}
        disabled={disabled}
        onClick={onClick}
        aria-label={`${t('af.rename')}: ${label}`}
        data-testid={testId}
      >
        <RenameOutlined />
      </button>
    </Tooltip>
  );
}

interface InlineNameEditorProps {
  initial: string;
  label: string;
  placeholder?: string;
  onCommit: (next: string) => Promise<boolean>;
  onCancel: () => void;
  'data-testid'?: string;
}

export function InlineNameEditor({ initial, label, placeholder, onCommit, onCancel, 'data-testid': testId }: InlineNameEditorProps) {
  const [draft, setDraft] = React.useState(initial);
  const [isSaving, setIsSaving] = React.useState(false);
  const isSettledRef = React.useRef(false);
  const isSavingRef = React.useRef(false);
  const commit = async () => {
    if (isSettledRef.current || isSavingRef.current) return;
    if (draft.trim() === initial) {
      isSettledRef.current = true;
      onCancel();
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    const isSaved = await onCommit(draft);
    isSavingRef.current = false;
    setIsSaving(false);
    if (isSaved) isSettledRef.current = true;
  };
  return (
    <Input
      size="sm"
      autoFocus
      className={styles.input}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      readOnly={isSaving}
      onChange={(event) => setDraft(event.target.value)}
      onPressEnter={() => void commit()}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || isSavingRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        isSettledRef.current = true;
        onCancel();
      }}
      data-testid={testId}
    />
  );
}
