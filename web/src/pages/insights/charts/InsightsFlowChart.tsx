import React from 'react';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { TooltipContent, TooltipReadout, TooltipRoot } from '@/components/ui/tooltip';
import { RADIUS } from '../../../theme/radius';
import { useTheme } from '../../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import type { FlowLink, FlowNode, InsightsDimension, InsightsMetric } from '../../../types/insightsCube';
import { useInsightsFormat } from '../useInsightsFormat';

export interface InsightsFlowChartProps {
  nodes: readonly FlowNode[];
  links: readonly FlowLink[];
  metric: InsightsMetric;
  colorOf: (node: FlowNode) => string;
  labelOf: (node: FlowNode) => string;
  isDimmed?: (node: FlowNode) => boolean;
  onSelect?: (dimension: InsightsDimension, value: string) => void;
  label: string;
  height?: number;
}

const NODE_WIDTH = 10;
const NODE_GAP = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 10;
const PAD_LEFT = 6;
const PAD_RIGHT_WIDE = 148;
const PAD_RIGHT_NARROW = 104;

interface LayoutNode {
  node: FlowNode;
  x: number;
  y: number;
  h: number;
  total: number;
  color: string;
  label: string;
}

interface LayoutRibbon {
  key: string;
  source: LayoutNode;
  target: LayoutNode;
  value: number;
  sy0: number;
  sy1: number;
  ty0: number;
  ty1: number;
  path: string;
}

function buildSankeyLayout(
  nodes: readonly FlowNode[],
  links: readonly FlowLink[],
  width: number,
  height: number,
  colorOf: (node: FlowNode) => string,
  labelOf: (node: FlowNode) => string,
): { layoutNodes: LayoutNode[]; ribbons: LayoutRibbon[] } {
  const padRight = width < 480 ? PAD_RIGHT_NARROW : PAD_RIGHT_WIDE;
  if (nodes.length === 0 || width <= PAD_LEFT + padRight) {
    return { layoutNodes: [], ribbons: [] };
  }

  const outSum = new Map<string, number>();
  const inSum = new Map<string, number>();
  for (const link of links) {
    outSum.set(link.source, (outSum.get(link.source) ?? 0) + link.value);
    inSum.set(link.target, (inSum.get(link.target) ?? 0) + link.value);
  }

  const maxLevel = Math.max(1, ...nodes.map((n) => n.level));
  const innerWidth = Math.max(60, width - PAD_LEFT - padRight - NODE_WIDTH);
  const innerHeight = Math.max(80, height - PAD_TOP - PAD_BOTTOM);

  const byLevel = new Map<number, FlowNode[]>();
  for (const node of nodes) {
    const bucket = byLevel.get(node.level) ?? [];
    bucket.push(node);
    byLevel.set(node.level, bucket);
  }

  const nodeMap = new Map<string, LayoutNode>();
  const layoutNodes: LayoutNode[] = [];

  for (const [level, levelNodes] of byLevel) {
    const totals = levelNodes.map((n) => Math.max(outSum.get(n.id) ?? 0, inSum.get(n.id) ?? 0));
    const sumTotal = totals.reduce((a, b) => a + b, 0);
    const totalGaps = Math.max(0, levelNodes.length - 1) * NODE_GAP;
    const usableH = Math.max(levelNodes.length * 4, innerHeight - totalGaps);
    const x = PAD_LEFT + (maxLevel === 0 ? 0 : (level / maxLevel) * innerWidth);

    let cursorY = PAD_TOP;
    levelNodes.forEach((node, idx) => {
      const total = totals[idx] ?? 0;
      const h = sumTotal > 0 ? Math.max(4, (total / sumTotal) * usableH) : usableH / levelNodes.length;
      const item: LayoutNode = {
        node,
        x,
        y: cursorY,
        h,
        total,
        color: colorOf(node),
        label: labelOf(node),
      };
      cursorY += h + NODE_GAP;
      nodeMap.set(node.id, item);
      layoutNodes.push(item);
    });
  }

  const sourceOffsets = new Map<string, number>();
  const targetOffsets = new Map<string, number>();
  const ribbons: LayoutRibbon[] = [];

  for (const link of links) {
    const source = nodeMap.get(link.source);
    const target = nodeMap.get(link.target);
    if (!source || !target || link.value <= 0) continue;

    const sh = source.total > 0 ? (link.value / source.total) * source.h : 0;
    const th = target.total > 0 ? (link.value / target.total) * target.h : 0;
    const sOff = sourceOffsets.get(source.node.id) ?? 0;
    const tOff = targetOffsets.get(target.node.id) ?? 0;
    sourceOffsets.set(source.node.id, sOff + sh);
    targetOffsets.set(target.node.id, tOff + th);

    const x0 = source.x + NODE_WIDTH;
    const x1 = target.x;
    const cx = (x0 + x1) / 2;
    const sy0 = source.y + sOff;
    const sy1 = sy0 + Math.max(1, sh);
    const ty0 = target.y + tOff;
    const ty1 = ty0 + Math.max(1, th);

    const path = `M ${x0} ${sy0} C ${cx} ${sy0}, ${cx} ${ty0}, ${x1} ${ty0} L ${x1} ${ty1} C ${cx} ${ty1}, ${cx} ${sy1}, ${x0} ${sy1} Z`;
    ribbons.push({
      key: `${link.source}->${link.target}`,
      source,
      target,
      value: link.value,
      sy0,
      sy1,
      ty0,
      ty1,
      path,
    });
  }

  return { layoutNodes, ribbons };
}

const InsightsFlowChartView: React.FC<InsightsFlowChartProps> = ({
  nodes,
  links,
  metric,
  colorOf,
  labelOf,
  isDimmed,
  onSelect,
  label,
  height = 320,
}) => {
  useTheme();
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(680);
  const [hoverTip, setHoverTip] = React.useState<{
    anchor: SVGElement;
    name: string;
    color?: string;
    value: number;
  } | null>(null);

  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const next = el.clientWidth;
      if (next > 0) setWidth(next);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    if (!hoverTip) return;
    const dismiss = () => setHoverTip(null);
    const onPointerDown = (event: Event) => {
      const el = containerRef.current;
      if (!el || !(event.target instanceof Node) || !el.contains(event.target)) {
        dismiss();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('touchstart', onPointerDown, { capture: true, passive: true });
    document.addEventListener('scroll', dismiss, { capture: true, passive: true });
    document.addEventListener('visibilitychange', dismiss);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('touchstart', onPointerDown, true);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('visibilitychange', dismiss);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [hoverTip]);

  const config = React.useMemo<ChartConfig>(() => ({}), []);
  const { layoutNodes, ribbons } = React.useMemo(
    () => buildSankeyLayout(nodes, links, width, height, colorOf, labelOf),
    [colorOf, height, labelOf, links, nodes, width],
  );

  return (
    <ChartContainer
      ref={containerRef}
      config={config}
      responsive={false}
      role="img"
      aria-label={label}
      data-testid="insights-flow-chart"
      style={{ height }}
      className="w-full"
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block overflow-visible"
        onClick={(e) => {
          if (e.target === e.currentTarget) setHoverTip(null);
        }}
      >
        <g>
          {ribbons.map((ribbon) => {
            const dimmed = Boolean(
              isDimmed && (isDimmed(ribbon.source.node) || isDimmed(ribbon.target.node)),
            );
            const baseWeight = ribbon.source.node.level === 0 ? 0.2 : 0.09;
            const opacity = dimmed ? baseWeight * 0.25 : isDimmed ? baseWeight * 1.5 : baseWeight;
            return (
              <path
                key={ribbon.key}
                d={ribbon.path}
                fill={ribbon.source.color}
                fillOpacity={opacity}
                className="transition-opacity duration-150 hover:fill-opacity-40"
                onPointerEnter={(e) => {
                  if (e.pointerType === 'touch') return;
                  setHoverTip({
                    anchor: e.currentTarget,
                    name: `${ribbon.source.label} → ${ribbon.target.label}`,
                    color: ribbon.source.color,
                    value: ribbon.value,
                  });
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType !== 'touch') setHoverTip(null);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  const el = e.currentTarget;
                  setHoverTip((prev) =>
                    prev?.anchor === el
                      ? null
                      : {
                          anchor: el,
                          name: `${ribbon.source.label} → ${ribbon.target.label}`,
                          color: ribbon.source.color,
                          value: ribbon.value,
                        },
                  );
                }}
              />
            );
          })}
        </g>
        <g>
          {layoutNodes.map((item) => {
            const dimmed = Boolean(isDimmed?.(item.node));
            const clickable = !item.node.folded && Boolean(onSelect);
            const displayLabel = item.label.length > 20 ? `${item.label.slice(0, 19)}…` : item.label;
            return (
              <g
                key={item.node.id}
                className={clickable ? 'cursor-pointer' : undefined}
                onClick={() => {
                  if (clickable) onSelect?.(item.node.dimension, item.node.value);
                }}
                onPointerEnter={(e) => {
                  if (e.pointerType === 'touch') return;
                  setHoverTip({
                    anchor: e.currentTarget,
                    name: item.label,
                    color: item.color,
                    value: item.total,
                  });
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType !== 'touch') setHoverTip(null);
                }}
              >
                <rect
                  x={item.x}
                  y={item.y}
                  width={NODE_WIDTH}
                  height={item.h}
                  rx={RADIUS.xs}
                  fill={item.color}
                  fillOpacity={dimmed ? 0.25 : 1}
                />
                <text
                  x={item.x + NODE_WIDTH + 8}
                  y={item.y + item.h / 2}
                  dominantBaseline="central"
                  fill="var(--fg)"
                  fillOpacity={dimmed ? 0.45 : 1}
                  fontSize={12}
                >
                  {displayLabel}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {hoverTip && (
        <TooltipRoot open>
          <TooltipContent anchor={hoverTip.anchor} side="top" sideOffset={6} className="rounded-lg px-3 py-2">
            <TooltipReadout
              rows={[
                {
                  name: hoverTip.name,
                  color: hoverTip.color,
                  value: formatMetric(metric, hoverTip.value, style),
                  note:
                    formatMetricExact(metric, hoverTip.value) !== formatMetric(metric, hoverTip.value, style)
                      ? formatMetricExact(metric, hoverTip.value)
                      : undefined,
                },
              ]}
            />
          </TooltipContent>
        </TooltipRoot>
      )}
    </ChartContainer>
  );
};

export const InsightsFlowChart = React.memo(InsightsFlowChartView);
export default InsightsFlowChart;
