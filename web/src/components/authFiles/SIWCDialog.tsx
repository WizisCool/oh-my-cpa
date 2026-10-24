import { Modal } from 'antd';
import { useT } from '../../i18n';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import type { SIWCBindings } from '../../hooks/useSIWCBindings';
import { maskAccount, maskAccountIn } from '../../utils/maskAccount';
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
  const targetName = identity?.isAccountPrimary ? maskAccount(identity.primary) : identity?.primary;
  return (
    <Modal open={Boolean(file)} title={t('siwc.title')} footer={null} onCancel={onClose} width={560} destroyOnHidden>
      {file && (
        <div className={styles.dialog} data-testid="siwc-dialog">
          <p className={styles.target} title={identity?.isAccountPrimary ? maskAccountIn(file.name, identity.primary) : file.name}>{targetName ?? file.name}</p>
          <SIWCBindingPanel file={file} canEdit={canEdit} bindings={bindings} />
        </div>
      )}
    </Modal>
  );
}
