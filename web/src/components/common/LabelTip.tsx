import { Tooltip } from 'antd';
import type { TooltipProps } from 'antd';
import { useCanHover } from '../../hooks/useCanHover';

/**
 * The name of an icon action, shown to a pointer that rests on it.
 *
 * It is drawn only where resting is possible. On a touch screen the hover that opens a tooltip is
 * the browser's leftover from the last tap, so a label would appear over a control nobody
 * touched - Send, after an example was tapped and the keyboard moved the composer under the
 * finger's last position. The control's accessible name carries the label there.
 *
 * For a name only: a tooltip that says something the control does not (a measurement's meaning, a
 * reason) stays an ordinary Tooltip, because a tap is the one way a touch reader can ask for it.
 */
export function LabelTip({ children, ...tooltip }: TooltipProps) {
  const canHover = useCanHover();
  return canHover ? <Tooltip {...tooltip}>{children}</Tooltip> : <>{children}</>;
}
