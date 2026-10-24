import React from 'react';
import { EChart } from '../../../charts/echarts/EChart';
import { renderChartTooltip } from '../../../charts/chartTooltip';
import { useTheme } from '../../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import type { FlowLink, FlowNode, InsightsDimension, InsightsMetric } from '../insightsCube';
import { formatMetric, formatMetricExact } from '../insightsFormat';

export interface InsightsFlowChartProps {
  nodes: readonly FlowNode[];
  links: readonly FlowLink[];
  metric: InsightsMetric;
  /** The first level's colours, from the page's ranking; later levels are neutral. */
  colorOf: (node: FlowNode) => string;
  labelOf: (node: FlowNode) => string;
  /** Steps back a node outside the page's narrowing, and every link that touches one. */
  isDimmed?: (node: FlowNode) => boolean;
  onSelect?: (dimension: InsightsDimension, value: string) => void;
  label: string;
  height?: number;
}

interface FlowEventParams {
  dataType?: 'node' | 'edge';
  value?: number;
  data?: { id?: string; source?: string; target?: string; value?: number; name?: string };
}

/**
 * Where traffic goes: each client key's volume through the call points it asked for to the providers
 * that served it. The first column carries the ranking's colours; the links take their source's, at a
 * low weight, so a key's traffic can be followed across without the chart turning into a rainbow.
 * Selecting a node narrows the page to it; the figure keeps every other path, stepped back, so the
 * choice reads against what it was chosen from.
 */
const InsightsFlowChartView: React.FC<InsightsFlowChartProps> = ({ nodes, links, metric, colorOf, labelOf, isDimmed, onSelect, label, height = 320 }) => {
  const { theme } = useTheme();
  const { style } = useTokenDisplayStyle();
  const byId = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectRef = React.useRef(onSelect);
  selectRef.current = onSelect;

  const option = React.useMemo(() => ({
    tooltip: {
      trigger: 'item',
      className: 'omc-echart-tip',
      formatter: (params: FlowEventParams) => {
        if (params.dataType === 'edge' && params.data?.source && params.data.target) {
          const source = byId.get(params.data.source);
          const target = byId.get(params.data.target);
          const value = params.data.value ?? 0;
          return renderChartTooltip(undefined, [{
            name: `${source ? labelOf(source) : ''} → ${target ? labelOf(target) : ''}`,
            value: formatMetric(metric, value, style),
            exact: formatMetricExact(metric, value),
          }]);
        }
        const node = params.data?.id ? byId.get(params.data.id) : undefined;
        const value = params.value ?? 0;
        return renderChartTooltip(undefined, [{
          name: node ? labelOf(node) : '',
          color: node ? colorOf(node) : undefined,
          value: formatMetric(metric, value, style),
          exact: formatMetricExact(metric, value),
        }]);
      },
    },
    series: [{
      id: 'flow',
      type: 'sankey',
      left: 4,
      right: 140,
      top: 8,
      bottom: 8,
      nodeWidth: 10,
      nodeGap: 10,
      nodeAlign: 'justify',
      draggable: false,
      layoutIterations: 32,
      emphasis: { focus: 'adjacency', lineStyle: { opacity: 0.45 } },
      label: { color: theme.palette.fg, fontSize: 11, overflow: 'truncate', width: 128 },
      lineStyle: { color: 'source', curveness: 0.5 },
      data: nodes.map((node) => ({
        id: node.id,
        name: node.id,
        label: { formatter: labelOf(node) },
        itemStyle: { color: colorOf(node), borderWidth: 0, opacity: isDimmed?.(node) ? 0.25 : 1 },
        depth: node.level,
      })),
      links: links.map((link) => {
        const source = byId.get(link.source);
        const target = byId.get(link.target);
        const isLinkDimmed = Boolean(isDimmed && ((source && isDimmed(source)) || (target && isDimmed(target))));
        // A key's colour is the figure's reading, so its links carry weight; past the first column a
        // model usually feeds one provider, and a band at the same weight drew as a grey box.
        const weight = (source?.level ?? 0) === 0 ? 0.2 : 0.08;
        return {
          source: link.source,
          target: link.target,
          value: link.value,
          lineStyle: { opacity: isLinkDimmed ? weight / 4 : isDimmed ? weight * 1.6 : weight },
        };
      }),
    }],
  }), [byId, colorOf, isDimmed, labelOf, links, metric, nodes, style, theme.palette.fg]);

  const handlers = React.useMemo(() => ({
    click: (params: unknown) => {
      const event = params as FlowEventParams;
      if (event.dataType !== 'node' || !event.data?.id) return;
      const node = byId.get(event.data.id);
      if (node && !node.folded) selectRef.current?.(node.dimension, node.value);
    },
  }), [byId]);

  return <EChart option={option} height={height} label={label} handlers={handlers} testId="insights-flow-chart" />;
};

export const InsightsFlowChart = React.memo(InsightsFlowChartView);
export default InsightsFlowChart;
