import React from 'react';
import { Checkbox, Input, Modal, Segmented } from 'antd';
import { useMutation } from '@tanstack/react-query';

import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { FileDropzone } from '../common/FileDropzone';
import { Notice, useToast } from '../feedback';
import {
  isValidAuthFileName,
  normalizeAuthFileName,
  readPastedAuthJson,
} from './pasteAuthJson';
import styles from './AuthJsonUploadModal.module.css';

type UploadMode = 'files' | 'paste';

interface AuthJsonUploadModalProps {
  open: boolean;
  /** Names already stored, so replacing one is an explicit choice. */
  existingNames: ReadonlySet<string>;
  onClose: () => void;
  /** Chosen files keep their own names and go through the batch upload. */
  onChooseFiles: (files: File[]) => void;
  onUploaded: () => void | Promise<void>;
}

/**
 * AuthJsonUploadModal adds credentials either from files or from JSON copied elsewhere,
 * so pasted text need not be saved to a file first. Pasted text goes through the same
 * single-file upload the gateway validates for a chosen file; only the provider type and
 * address are shown back.
 */
export const AuthJsonUploadModal: React.FC<AuthJsonUploadModalProps> = ({ open, existingNames, onClose, onChooseFiles, onUploaded }) => {
  const t = useT();
  const toast = useToast();
  const [mode, setMode] = React.useState<UploadMode>('files');
  const [text, setText] = React.useState('');
  const [editedName, setEditedName] = React.useState<string | null>(null);
  const [canReplace, setCanReplace] = React.useState(false);
  // Names found stored by the lookup at submit, beyond the page's possibly partial or stale list.
  const [foundNames, setFoundNames] = React.useState<ReadonlySet<string>>(() => new Set());

  // The pasted text is a secret: it must not outlive the dialog.
  React.useEffect(() => {
    if (!open) {
      setMode('files');
      setText('');
      setEditedName(null);
      setCanReplace(false);
      setFoundNames(new Set());
    }
  }, [open]);

  const reading = React.useMemo(() => (text.trim() ? readPastedAuthJson(text) : null), [text]);
  const nameInput = editedName ?? reading?.summary?.suggestedName ?? '';
  const name = normalizeAuthFileName(nameInput);
  const isNameValid = isValidAuthFileName(name);
  const isReplacing = isNameValid && (existingNames.has(name) || foundNames.has(name));

  // Text is read from the closure rather than passed as a variable React Query would cache.
  const uploadMutation = useMutation({
    mutationFn: async () => {
      // CPA replaces a stored name without asking, and the page's list may be capped or stale,
      // so an unconfirmed name is looked up first and held for confirmation if it is taken.
      if (!canReplace) {
        const stored = await api.getManagementAuthFiles({ name });
        if (stored.files.some((file) => file.name === name)) return { isHeld: true };
      }
      await api.uploadManagementAuthJson(name, text);
      return { isHeld: false };
    },
    onSuccess: async ({ isHeld }) => {
      if (isHeld) {
        setFoundNames((previous) => new Set(previous).add(name));
        return;
      }
      toast.success(t('af.paste_uploaded', { name }));
      onClose();
      await onUploaded();
    },
    onError: (err: unknown) => toast.error(t('af.paste_failed', { err: describeError(err) })),
  });

  const canUpload = Boolean(reading?.summary) && isNameValid && (!isReplacing || canReplace);

  return (
    <Modal
      open={open}
      title={t('af.upload_title')}
      okText={t('af.paste_submit')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !canUpload, loading: uploadMutation.isPending }}
      // The upload cannot be aborted once sent, so the dialog stays until its outcome is known.
      cancelButtonProps={{ disabled: uploadMutation.isPending }}
      closable={!uploadMutation.isPending}
      mask={{ closable: !uploadMutation.isPending }}
      keyboard={!uploadMutation.isPending}
      // Chosen files upload as soon as they are picked; only pasted text needs a submit.
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          <CancelBtn />
          {mode === 'paste' && <OkBtn />}
        </>
      )}
      onOk={() => {
        if (canUpload) uploadMutation.mutate();
      }}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className={styles.body}>
        <Segmented
          block
          value={mode}
          disabled={uploadMutation.isPending}
          options={[
            { value: 'files', label: t('af.upload_mode_files') },
            { value: 'paste', label: t('af.paste_json') },
          ]}
          onChange={(value) => setMode(value as UploadMode)}
        />
        {mode === 'files' ? (
          <FileDropzone
            title={t('af.upload_drop_title')}
            hint={t('af.upload_drop_hint')}
            chooseLabel={t('af.upload_choose')}
            inputLabel={t('af.upload_mode_files')}
            accept=".json,application/json"
            multiple
            onFiles={onChooseFiles}
          />
        ) : (
          <>
            <div>
              <Input.TextArea
                aria-label={t('af.paste_json')}
                className={styles.json}
                value={text}
                autoSize={{ minRows: 8, maxRows: 14 }}
                spellCheck={false}
                autoComplete="off"
                placeholder={t('af.paste_placeholder')}
                onChange={(event) => setText(event.target.value)}
              />
              {reading && !reading.summary && <p className={styles.problem} role="alert">{t('af.paste_problem_not_object')}</p>}
            </div>
            {reading?.summary && (
              <dl className={styles.summary}>
                <dt>{t('af.paste_type')}</dt>
                <dd>{reading.summary.type || '—'}</dd>
                <dt>{t('af.paste_email')}</dt>
                <dd>{reading.summary.email || '—'}</dd>
              </dl>
            )}
            <div>
              <label className={styles.label} htmlFor="paste-auth-json-name">{t('af.paste_name')}</label>
              <Input
                id="paste-auth-json-name"
                value={nameInput}
                disabled={!reading?.summary}
                status={!nameInput || isNameValid ? undefined : 'error'}
                onChange={(event) => {
                  setEditedName(event.target.value);
                  setCanReplace(false);
                }}
              />
              {nameInput && !isNameValid && <p className={styles.problem} role="alert">{t('af.paste_name_invalid')}</p>}
            </div>
            {isReplacing && (
              <Notice
                tone="warning"
                title={t('af.paste_replace_note', { name })}
                action={(
                  <Checkbox checked={canReplace} onChange={(event) => setCanReplace(event.target.checked)}>
                    {t('af.paste_replace_confirm')}
                  </Checkbox>
                )}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
