import clsx from 'clsx';
import { LoadingRegion, Placeholder } from '../common/Placeholder';
import { PlaceholderLines } from '../common/ContentPlaceholder';

/**
 * First-load frame of a conversation page (Agent or Playground): optional top workspace bar,
 * user turn bubble, assistant reply rows with avatar mark, and resting composer card.
 *
 * Pages that already render their own header (`AgentPage` bar) or composer (`AgentPage` bottom
 * input) pass `hasHeader={false}` / `hasComposer={false}` so placeholders never duplicate live chrome.
 */
export function ThreadPlaceholder({
  testId,
  isImmediate = false,
  hasHeader = false,
  hasComposer = true,
}: {
  testId?: string;
  isImmediate?: boolean;
  hasHeader?: boolean;
  hasComposer?: boolean;
}) {
  return (
    <div className={clsx('thread-placeholder-shell', hasHeader && 'has-header')} data-testid={testId}>
      {hasHeader && (
        <div className="thread-placeholder-head" aria-hidden="true">
          <Placeholder width={112} className="placeholder-title" />
          <div className="thread-placeholder-head-actions">
            <Placeholder width={32} height={32} className="is-control" />
            <Placeholder width={32} height={32} className="is-control" />
            <Placeholder width={32} height={32} className="is-control" />
          </div>
        </div>
      )}
      <LoadingRegion isImmediate={isImmediate} className="thread-placeholder">
        <div className="thread-placeholder-column">
          <Placeholder width="36%" height={36} className="thread-placeholder-question is-surface" />
          <div className="thread-placeholder-reply">
            <Placeholder width={24} height={24} row={1} className="is-circle" />
            <PlaceholderLines widths={['92%', '80%', '58%']} row={1} />
          </div>
          <Placeholder width="28%" height={36} row={4} className="thread-placeholder-question is-surface" />
          <div className="thread-placeholder-reply">
            <Placeholder width={24} height={24} row={5} className="is-circle" />
            <PlaceholderLines widths={['84%', '66%']} row={5} />
          </div>
        </div>
        {hasComposer && (
          <div className="thread-placeholder-composer" aria-hidden="true">
            <Placeholder width="42%" row={7} className="placeholder-line" />
            <div className="thread-placeholder-composer-foot">
              <div className="thread-placeholder-composer-tools">
                <Placeholder width={88} height={26} row={7} className="is-control" />
                <Placeholder width={64} height={26} row={7} className="is-control" />
              </div>
              <Placeholder width={30} height={30} row={7} className="is-control" />
            </div>
          </div>
        )}
      </LoadingRegion>
    </div>
  );
}
