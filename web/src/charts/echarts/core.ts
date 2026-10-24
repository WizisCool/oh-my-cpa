/**
 * The ECharts runtime, registered piece by piece.
 *
 * Only what the Insights page draws is imported - bars, lines and the flow diagram, on a grid with a
 * tooltip, a brush, reference lines and marked areas - so the chunk carries no chart type nobody asked for. The
 * brush's preprocessor always attaches a toolbox for its buttons, so the toolbox is registered and the
 * trend hides it - the drag is armed directly instead. The renderer is SVG: the page's data is a few hundred marks at most, SVG text is laid out by the
 * browser in the console's own typeface, and every mark is an element a check can read. See
 * docs/adr/0106-insights-charts-use-apache-echarts.md.
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, SankeyChart } from 'echarts/charts';
import {
  AriaComponent,
  BrushComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, SankeyChart, AriaComponent, BrushComponent, GridComponent, MarkAreaComponent, MarkLineComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);

export { echarts };
export type { EChartsCoreOption, ECharts, SetOptionOpts } from 'echarts/core';
