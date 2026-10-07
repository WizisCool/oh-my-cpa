import React from 'react';
import { Button, Segmented, Tooltip } from 'antd';
import { DownloadOutlined, LineChartOutlined, TableOutlined } from '../../../components/icons';
import { exportFileName } from '../../../agent/export';
import type { DisplayView, Trace } from '../../../agent/types';
import { useI18n } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import { saveBlob } from '../../../utils/download';
import { CanvasView } from './CanvasView';
import { CapabilityCall } from './CapabilityCall';
import { PanelView } from './PanelView';
import { TableView } from './TableView';
import styles from '../AgentPage.module.css';

const ChartView = React.lazy(() => import('./ChartView'));

/**
 * Exports the drawn chart as a PNG on the theme's own surface. The canvas itself is transparent, so
 * a copy saved from a dark page would be light text on nothing; compositing onto the surface keeps
 * it readable wherever it is pasted.
 */
async function downloadChart(container: HTMLDivElement | null, background: string, fileName: string): Promise<void> {
  const source = container?.querySelector('canvas');
  if (!source) return;
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (blob) saveBlob(blob, fileName);
}

/** A display call's frozen view, drawn inside the answer by the component for its kind. */
export function DisplayFigure({ view }: { view: DisplayView }) {
  if (view.kind === 'panel') return <PanelView view={view} />;
  if (view.kind === 'canvas') return <CanvasView view={view} />;
  return <DataFigure view={view} />;
}

function DataFigure({ view }: { view: DisplayView }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isChart = view.kind === 'chart' && !!view.chart;
  const [mode, setMode] = React.useState<'chart' | 'table'>(isChart ? 'chart' : 'table');
  const chartRef = React.useRef<HTMLDivElement>(null);
  const title = <span className={styles['view-title']}>{view.title}</span>;
  if (!isChart || mode === 'table') {
    return (
      <figure className={styles['view']} data-testid="agent-view" data-kind={view.kind}>
        <TableView
          table={view}
          title={view.title}
          heading={(
            <>
              {title}
              {isChart && <ModeSwitch mode={mode} onChange={setMode} />}
            </>
          )}
        />
      </figure>
    );
  }
  return (
    <figure className={styles['view']} data-testid="agent-view" data-kind={view.kind}>
      <div className={styles['view-head']}>
        {title}
        <ModeSwitch mode={mode} onChange={setMode} />
        <span className={styles['view-spacer']} />
        <Tooltip title={t('agent.view.download_png')}>
          <Button
            type="text"
            size="small"
            aria-label={t('agent.view.download_png')}
            icon={<DownloadOutlined />}
            onClick={() => void downloadChart(chartRef.current, theme.palette.surface, exportFileName(view.title, 'png', new Date()))}
          />
        </Tooltip>
      </div>
      <React.Suspense fallback={<div className="chart-placeholder" style={{ height: 260 }} aria-hidden="true" />}>
        <ChartView view={view} containerRef={chartRef} />
      </React.Suspense>
    </figure>
  );
}

function ModeSwitch({ mode, onChange }: { mode: 'chart' | 'table'; onChange: (mode: 'chart' | 'table') => void }) {
  const { t } = useI18n();
  return (
    <Segmented
      size="small"
      value={mode}
      onChange={value => onChange(value as 'chart' | 'table')}
      options={[
        { value: 'chart', icon: <LineChartOutlined />, title: t('agent.view.chart'), label: <span className={styles['view-mode-label']}>{t('agent.view.chart')}</span> },
        { value: 'table', icon: <TableOutlined />, title: t('agent.view.data'), label: <span className={styles['view-mode-label']}>{t('agent.view.data')}</span> },
      ]}
    />
  );
}

export interface DisplayCallProps {
  trace: Trace;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

/** Display preparation stays in the trace; the successful answer owns the figures. */
export function DisplayCall({ trace, isSelected, onSelect }: DisplayCallProps) {
  return <CapabilityCall trace={trace} isSelected={isSelected} onSelect={onSelect} />;
}
