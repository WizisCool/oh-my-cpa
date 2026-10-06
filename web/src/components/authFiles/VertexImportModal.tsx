import React from 'react';
import { Button, Input, Modal } from 'antd';
import { useMutation } from '@tanstack/react-query';

import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { UploadOutlined } from '../icons';
import { Notice, useToast } from '../feedback';
import {
  DEFAULT_VERTEX_LOCATION,
  isValidVertexLocation,
  MAX_VERTEX_KEY_BYTES,
  readVertexKey,
  type VertexKeyProblem,
  type VertexKeySummary,
} from './vertexImport';
import styles from './VertexImportModal.module.css';

const PROBLEM_KEYS: Record<VertexKeyProblem, string> = {
  too_large: 'af.vertex_problem_too_large',
  not_json: 'af.vertex_problem_not_json',
  no_private_key: 'af.vertex_problem_no_private_key',
  no_project: 'af.vertex_problem_no_project',
};

interface ChosenKey {
  fileName: string;
  summary?: VertexKeySummary;
  problem?: VertexKeyProblem;
}

interface VertexImportModalProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void | Promise<void>;
}

/**
 * VertexImportModal stores a Google service-account key as a Vertex credential.
 *
 * It is its own dialog rather than part of the JSON upload because the gateway does not
 * store the key as it is: it wraps it with a region and names the file after the key's
 * project, replacing a credential already imported for that project. The dialog shows the
 * project and the account before anything is sent, so that replacement is a choice.
 */
export const VertexImportModal: React.FC<VertexImportModalProps> = ({ open, onClose, onImported }) => {
  const t = useT();
  const toast = useToast();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [chosenKey, setChosenKey] = React.useState<ChosenKey | null>(null);
  const [location, setLocation] = React.useState('');
  const keyTextRef = React.useRef('');
  const fileSelectionRevisionRef = React.useRef(0);

  // Neither React Query's cached mutation variables nor a completed file read may
  // retain a secret after its dialog closes. Cleanup also invalidates pending reads.
  React.useEffect(() => {
    if (!open) {
      keyTextRef.current = '';
      setChosenKey(null);
      setLocation('');
    }
    return () => {
      keyTextRef.current = '';
      fileSelectionRevisionRef.current += 1;
    };
  }, [open]);

  const importMutation = useMutation({
    mutationFn: () => {
      if (!keyTextRef.current) throw new Error(t('af.vertex_problem_no_private_key'));
      return api.importVertexServiceAccount(keyTextRef.current, location.trim());
    },
    onSuccess: async (result) => {
      toast.success(t('af.vertex_imported', { name: result.name || result.project_id, location: result.location }));
      onClose();
      await onImported();
    },
    onError: (err: unknown) => toast.error(t('af.vertex_import_failed', { err: describeError(err) })),
  });

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    const selectionRevision = ++fileSelectionRevisionRef.current;
    keyTextRef.current = '';
    setChosenKey(null);
    if (file.size > MAX_VERTEX_KEY_BYTES) {
      setChosenKey({ fileName: file.name, problem: 'too_large' });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (selectionRevision === fileSelectionRevisionRef.current) {
        setChosenKey({ fileName: file.name, problem: 'not_json' });
      }
      return;
    }
    if (selectionRevision !== fileSelectionRevisionRef.current) return;
    const reading = readVertexKey(text);
    if (reading.summary) keyTextRef.current = text;
    setChosenKey({ fileName: file.name, ...reading });
  };

  const isLocationValid = isValidVertexLocation(location);
  const canImport = Boolean(chosenKey?.summary) && isLocationValid;

  return (
    <Modal
      open={open}
      title={t('af.vertex_title')}
      okText={t('af.vertex_import')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !canImport, loading: importMutation.isPending }}
      onOk={() => {
        if (canImport) importMutation.mutate();
      }}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className={styles.body}>
        <Notice tone="info" title={t('af.vertex_replace_note')} />
        <div>
          <span className={styles.label}>{t('af.vertex_file')}</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              void chooseFile(file);
            }}
          />
          <div className={styles['file-row']}>
            <Button icon={<UploadOutlined />} onClick={() => fileInputRef.current?.click()}>
              {t('af.vertex_choose')}
            </Button>
            {chosenKey && <span className={styles['file-name']}>{chosenKey.fileName}</span>}
          </div>
          {chosenKey?.problem && <p className={styles.problem} role="alert">{t(PROBLEM_KEYS[chosenKey.problem])}</p>}
        </div>
        {chosenKey?.summary && (
          <dl className={styles.summary}>
            <dt>{t('af.vertex_project')}</dt>
            <dd>{chosenKey.summary.projectId}</dd>
            <dt>{t('af.vertex_email')}</dt>
            <dd>{chosenKey.summary.email || '—'}</dd>
          </dl>
        )}
        <div>
          <label className={styles.label} htmlFor="vertex-import-location">{t('af.vertex_location')}</label>
          <Input
            id="vertex-import-location"
            value={location}
            placeholder={DEFAULT_VERTEX_LOCATION}
            status={isLocationValid ? undefined : 'error'}
            onChange={(event) => setLocation(event.target.value)}
          />
          {isLocationValid
            ? <p className={styles.desc}>{t('af.vertex_location_desc', { location: DEFAULT_VERTEX_LOCATION })}</p>
            : <p className={styles.problem} role="alert">{t('af.vertex_location_invalid')}</p>}
        </div>
      </div>
    </Modal>
  );
};
