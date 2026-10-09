import { resolveModelManufacturer } from '../../types/modelSquare';
import { BoxOutlined } from '../icons';
import { LobeIcon } from '../LobeIcon';
import styles from './Workspace.module.css';

/** The maker's mark for a call point, read from its name; an unrecognised name gets a neutral box. */
export function ModelMark({ callPoint }: { callPoint: string }) {
  const manufacturer = resolveModelManufacturer(callPoint);
  const iconId = manufacturer.modelIconId || manufacturer.iconId;
  return iconId
    ? <LobeIcon iconId={iconId} size={14} />
    : <BoxOutlined className={styles['model-mark-fallback']} aria-hidden="true" />;
}
