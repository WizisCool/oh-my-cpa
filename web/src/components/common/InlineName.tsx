import React from 'react';
import { Input } from 'antd';
import { RenameOutlined } from '../icons';
import { useT } from '../../i18n';
import { Tooltip } from './Tooltip';
import styles from './InlineName.module.css';

/** The class a row's identity block takes so its rename glyph can sit beside the name. */
export const inlineNameEditableClass = styles.editable;

/** Added beside the editable class where no row menu offers the same rename, so touch can reach it. */
export const inlineNamePersistentClass = styles.persistent;

interface RenameButtonProps {
  /** What the glyph renames, for assistive tech. */
  label: string;
  disabled?: boolean;
  onClick: () => void;
  'data-testid'?: string;
}

/**
 * The glyph that opens a row's name editor. It appears while the pointer is over the name's cell
 * or the block has focus. On a touch screen it is hidden where a row menu offers the same rename,
 * and stays painted where nothing else does (`inlineNamePersistentClass`).
 */
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
  /** Saves the draft; resolves whether it was saved, so a refused name keeps the field open. */
  onCommit: (next: string) => Promise<boolean>;
  onCancel: () => void;
  'data-testid'?: string;
}

/**
 * A row's name, edited where it stands. Enter or leaving the field saves, Escape abandons; an
 * unchanged or failed save leaves the name as it was, and a failure keeps the field open with what
 * the operator typed.
 */
export function InlineNameEditor({ initial, label, placeholder, onCommit, onCancel, 'data-testid': testId }: InlineNameEditorProps) {
  const [draft, setDraft] = React.useState(initial);
  const [isSaving, setIsSaving] = React.useState(false);
  // Enter saves and then the field unmounts, which blurs it; Escape unmounts it too. Either way the
  // blur that follows must not save a second time, and neither may a blur during the save.
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
      size="small"
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
