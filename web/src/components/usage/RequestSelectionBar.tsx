import { Button } from 'antd';

import { useT } from '../../i18n';
import { SelectionBar } from '../common/SelectionBar';
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
    <SelectionBar
      variant="inline"
      className="request-selection-bar"
      label={t('events.selection')}
      summary={t('events.selected_count', { n: count })}
      selection={(
        <>
          {!isEveryLoadedSelected && (
            <Button type="link" size="small" onClick={onSelectLoaded}>
              {t('events.select_all')}
            </Button>
          )}
          <Button type="link" size="small" onClick={onClear}>
            {t('events.clear_selection')}
          </Button>
        </>
      )}
    >
      <Button
        type="primary"
        size="small"
        icon={<DownloadOutlined />}
        onClick={onExport}
        data-testid="req-export-open"
      >
        {t('events.export')}
      </Button>
    </SelectionBar>
  );
}
