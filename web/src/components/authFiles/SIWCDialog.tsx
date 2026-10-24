import { Modal } from 'antd';
import { useT } from '../../i18n';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import type { SIWCBindings } from '../../hooks/useSIWCBindings';
import { deriveAuthFileIdentity } from './authFileLogic';
import { SIWCBindingPanel } from './SIWCBindingPanel';
import styles from './SIWCBindingPanel.module.css';

interface SIWCDialogProps {
  file?: ManagementAuthFile;
  canEdit: boolean;
  bindings: SIWCBindings;
  onClose: () => void;
}

/**
 * SIWC for one Codex credential, opened from its row.
 *
 * The binding attempt belongs to the page's `useSIWCBindings`, not to this dialog: closing it while
 * CPA waits for the callback leaves the attempt running, and the row's badge keeps saying so.
 */
export function SIWCDialog({ file, canEdit, bindings, onClose }: SIWCDialogProps) {
  const t = useT();
  const identity = file ? deriveAuthFileIdentity(file) : undefined;
  return (
    <Modal open={Boolean(file)} title={t('siwc.title')} footer={null} onCancel={onClose} width={560} destroyOnHidden>
      {file && (
        <div className={styles.dialog} data-testid="siwc-dialog">
          <p className={styles.target} title={file.name}>{identity?.primary ?? file.name}</p>
          <SIWCBindingPanel file={file} canEdit={canEdit} bindings={bindings} />
        </div>
      )}
    </Modal>
  );
}
