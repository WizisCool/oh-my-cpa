import { ModelMark as BaseModelMark } from '../ModelMark';
import styles from './Workspace.module.css';

/** The maker's mark for a call point, read from its name; an unrecognised name gets a neutral box. */
export function ModelMark({ callPoint }: { callPoint: string }) {
  return <BaseModelMark callPoint={callPoint} size={14} className={styles['model-mark-fallback']} />;
}
