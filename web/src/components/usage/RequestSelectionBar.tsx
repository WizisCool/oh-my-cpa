import { Button } from 'antd';

import { useT } from '../../i18n';
import { DownloadOutlined } from '../icons';

interface RequestSelectionBarProps {
  count: number;
  isEveryLoadedSelected: boolean;
  onSelectLoaded: () => void;
  onClear: () => void;
  onExport: () => void;
}

/**
 * What the operator can do with the rows they ticked.
 *
 * It appears with the first tick and leaves with the last, so a list nobody is
 * selecting from carries no extra chrome. "Select all" is repeated here because
 * the stacked layout has no header row to hold the header's checkbox.
 */
export function RequestSelectionBar({
  count,
  isEveryLoadedSelected,
  onSelectLoaded,
  onClear,
  onExport,
}: RequestSelectionBarProps) {
  const t = useT();
  return (
    <div className="request-selection-bar" role="region" aria-label={t('events.selection')}>
      <span className="request-selection-count" role="status">
        {t('events.selected_count', { n: count })}
      </span>
      {!isEveryLoadedSelected && (
        <Button type="link" size="small" onClick={onSelectLoaded}>
          {t('events.select_all')}
        </Button>
      )}
      <Button type="link" size="small" onClick={onClear}>
        {t('events.clear_selection')}
      </Button>
      <Button
        className="request-selection-export"
        type="primary"
        size="small"
        icon={<DownloadOutlined />}
        onClick={onExport}
        data-testid="req-export-open"
      >
        {t('events.export')}
      </Button>
    </div>
  );
}
