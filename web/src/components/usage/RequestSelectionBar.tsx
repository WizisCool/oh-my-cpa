import { Button } from '@/components/ui/button';

import { useT } from '../../i18n';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { SelectionBar } from '../common/SelectionBar';
import { ToolButton } from '../common/ToolButton';
import { CloseOutlined, DownloadOutlined } from '../icons';

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
 * the stacked layout has no header row to hold the header's checkbox. On a phone
 * the bar keeps to one line, so clearing and exporting become glyphs.
 */
export function RequestSelectionBar({
  count,
  isEveryLoadedSelected,
  onSelectLoaded,
  onClear,
  onExport,
}: RequestSelectionBarProps) {
  const t = useT();
  const isPhone = useIsPhoneViewport();
  return (
    <SelectionBar
      label={t('events.selection')}
      summary={t('events.selected_count', { n: count })}
      selection={(
        <>
          {!isEveryLoadedSelected && (
            <Button variant="link" size="sm" onClick={onSelectLoaded}>
              <span className="truncate">{isPhone ? t('pro.select_all') : t('events.select_all')}</span>
            </Button>
          )}
          {!isPhone && (
            <Button variant="link" size="sm" onClick={onClear}>
              {t('events.clear_selection')}
            </Button>
          )}
        </>
      )}
    >
      {isPhone ? (
        <>
          <ToolButton variant="ghost" size="sm" icon={<CloseOutlined />} label={t('events.clear_selection')} onClick={onClear} />
          <ToolButton
            variant="primary"
            size="sm"
            icon={<DownloadOutlined />}
            label={t('events.export')}
            onClick={onExport}
            data-testid="req-export-open"
          />
        </>
      ) : (
        <Button
          variant="primary"
          size="sm"
          icon={<DownloadOutlined />}
          onClick={onExport}
          data-testid="req-export-open"
        >
          {t('events.export')}
        </Button>
      )}
    </SelectionBar>
  );
}
