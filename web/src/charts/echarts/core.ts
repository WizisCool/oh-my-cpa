/**
 * Shared SVG runtime for Insights and the dashboard. Register only the marks and components these
 * pages draw, keeping chart creation and loading outside the app shell. The brush preprocessor needs
 * the toolbox even when its buttons are hidden.
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, SankeyChart } from 'echarts/charts';
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

echarts.use([BarChart, LineChart, PieChart, SankeyChart, AriaComponent, BrushComponent, GridComponent, MarkAreaComponent, MarkLineComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);

export { echarts };
export type { EChartsCoreOption, ECharts, SetOptionOpts } from 'echarts/core';
