import { ReloadOutlined } from '../icons';
import { useT } from '../../i18n';
import { ToolButton, type ToolButtonProps } from './ToolButton';

export interface RefreshButtonProps {
  onRefresh: () => void;
  /** True while a read is in flight; the glyph turns rather than the button locking. */
  isRefreshing?: boolean;
  /** Overrides the plain "Refresh" name, for a control that re-reads something narrower. */
  label?: string;
  disabled?: boolean;
  size?: ToolButtonProps['size'];
  className?: string;
}

export function RefreshButton({
  onRefresh,
  isRefreshing = false,
  label,
  disabled,
  size,
  className,
}: RefreshButtonProps) {
  const t = useT();
  const name = label ?? t('common.refresh');
  const icon = <ReloadOutlined spin={isRefreshing} />;
  return (
    <ToolButton
      size={size}
      className={className}
      icon={icon}
      label={name}
      aria-busy={isRefreshing}
      disabled={disabled}
      onClick={onRefresh}
    />
  );
}
