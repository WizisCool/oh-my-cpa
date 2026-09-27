import { Button, Tooltip } from 'antd';
import type { ButtonProps } from 'antd';
import { ReloadOutlined } from '../icons';
import { useT } from '../../i18n';

export interface RefreshButtonProps {
  onRefresh: () => void;
  /** True while a read is in flight; the glyph turns rather than the button locking. */
  isRefreshing?: boolean;
  /** Overrides the plain "Refresh" name, for a control that re-reads something narrower. */
  label?: string;
  /** Draws the glyph alone, named by its tooltip, for a toolbar that is already crowded. */
  isIconOnly?: boolean;
  disabled?: boolean;
  size?: ButtonProps['size'];
  className?: string;
}

/**
 * The console's one page-refresh control.
 *
 * The glyph is the header's own (`ReloadOutlined`), so the page control and the global one read
 * as the same action at two scopes; `SyncOutlined` stays reserved for a synchronisation job such
 * as a catalogue sync. A read in flight spins the glyph instead of setting antd's `loading`,
 * because `loading` swallows clicks and swaps the glyph for a spinner of another shape - the
 * button would appear to change identity every time a background poll ran.
 */
export function RefreshButton({
  onRefresh,
  isRefreshing = false,
  label,
  isIconOnly = false,
  disabled,
  size,
  className,
}: RefreshButtonProps) {
  const t = useT();
  const name = label ?? t('common.refresh');
  const icon = <ReloadOutlined spin={isRefreshing} />;
  if (isIconOnly) {
    return (
      <Tooltip title={name}>
        <Button
          size={size}
          className={className}
          icon={icon}
          aria-label={name}
          aria-busy={isRefreshing}
          disabled={disabled}
          onClick={onRefresh}
        />
      </Tooltip>
    );
  }
  return (
    <Button size={size} className={className} icon={icon} aria-busy={isRefreshing} disabled={disabled} onClick={onRefresh}>
      {name}
    </Button>
  );
}
