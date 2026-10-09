import { LoadingRegion, Placeholder } from '../common/Placeholder';
import styles from './Workspace.module.css';

/**
 * A stored conversation on its first load: a question at the trailing edge and an answer under
 * it, twice, at the thread's own column width, so the turns that replace it land in place.
 */
export function ThreadPlaceholder({ testId }: { testId?: string }) {
  return (
    <LoadingRegion className={styles['thread-placeholder']}>
      <div className={styles['thread-placeholder-column']} data-testid={testId}>
        <Placeholder width="38%" height={34} className={styles['thread-placeholder-question']} />
        <div className="placeholder-lines">
          <Placeholder width="92%" row={1} className="placeholder-line" />
          <Placeholder width="80%" row={2} className="placeholder-line" />
          <Placeholder width="58%" row={3} className="placeholder-line" />
        </div>
        <Placeholder width="30%" height={34} row={4} className={styles['thread-placeholder-question']} />
        <div className="placeholder-lines">
          <Placeholder width="84%" row={5} className="placeholder-line" />
          <Placeholder width="66%" row={6} className="placeholder-line" />
        </div>
      </div>
    </LoadingRegion>
  );
}
