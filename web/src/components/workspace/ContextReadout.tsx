import { Tooltip } from 'antd';
import { useI18n } from '../../i18n';
import { formatTokens } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { CONTEXT_DANGER_SHARE, CONTEXT_WARNING_SHARE, contextShare } from './contextShare';
import styles from './Workspace.module.css';

export interface ContextReadoutProps {
  /** The input the model last read for this conversation. */
  usedTokens?: number;
  /** The model's context window, from the reference catalog. */
  windowTokens?: number;
}

const RING_RADIUS = 6;

/**
 * How much of the model's context window the conversation occupies.
 *
 * It is drawn only when both figures exist: the gateway reported the last round's input, and the
 * reference catalog lists a window for the model. The window is reference information rather than
 * a limit the gateway certifies, which the tooltip says; a guess in either place would read as a
 * measurement.
 *
 * A ring states a share at a glance where a bare figure has to be read; the figure stays beside it
 * because a 16px arc cannot tell 74% from 76%, which is where its tone changes.
 */
export function ContextReadout({ usedTokens, windowTokens }: ContextReadoutProps) {
  const { t } = useI18n();
  const { style } = useTokenDisplayStyle();
  const share = contextShare(usedTokens, windowTokens);
  if (share === undefined || usedTokens === undefined || windowTokens === undefined) return null;
  const percent = `${Math.round(share * 100)}%`;
  const detail = t('conversation.context.detail', { used: formatTokens(usedTokens, style), window: formatTokens(windowTokens, style) });
  return (
    <Tooltip title={detail}>
      <span
        className={styles['context-readout']}
        data-testid="context-readout"
        data-tone={share >= CONTEXT_DANGER_SHARE ? 'danger' : share >= CONTEXT_WARNING_SHARE ? 'warning' : undefined}
        role="meter"
        aria-label={t('conversation.context')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
        aria-valuetext={detail}
      >
        <svg className={styles['context-ring']} viewBox="0 0 16 16" aria-hidden="true">
          <circle className={styles['context-ring-track']} cx="8" cy="8" r={RING_RADIUS} />
          {/* pathLength makes the dash arithmetic a percentage, whatever the radius. */}
          <circle className={styles['context-ring-value']} cx="8" cy="8" r={RING_RADIUS} pathLength={100} strokeDasharray={`${share * 100} 100`} />
        </svg>
        <span>{percent}</span>
      </span>
    </Tooltip>
  );
}
