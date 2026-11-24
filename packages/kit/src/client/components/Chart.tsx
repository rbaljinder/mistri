/**
 * Charts for dashboards: barrel re-exporting line, sparkline, bar, stacked,
 * and donut chart shapes alongside shared axis helpers and stylesheet.
 */
/* The charts' own sheet travels with the chunk that draws them (onDemand). */
import './Chart.css';
import { say as sayCopy } from '../copy/dashboards/components/Chart.js';

export { BarChart, StackedBars, StackedColumns } from './ChartBars.js';
export { DonutChart, sliceRing } from './ChartDonut.js';
export { LineChart, Sparkline } from './ChartLines.js';
export { axisMarks, namesAtEnds, periodTick, TIMED_HEIGHT, TONE_INK, type PartialPeriods } from './chartAxes.js';

/* Keep literal catalog ownership anchored to Chart.tsx for check-client-copy.mjs while each split module calls sayCopy directly. */
void function chartCatalogKeys() {
  return [
    sayCopy('notEnoughPointsToDraw'),
    sayCopy('target', { goal: '' }),
    sayCopy('nothingToDraw'),
    sayCopy('nothingToDivide'),
    sayCopy('inAll', { whole: '', map: '' }),
    sayCopy('nothingToStack'),
    sayCopy('others', { restCount: 0 }),
    sayCopy('targetLabel'),
    sayCopy('lineSummary', { count: 0, from: '', to: '', peak: '' }),
    sayCopy('barsSummary', { count: 0, highest: '', last: '', value: '' }),
    sayCopy('barsBySeries', { count: 0, series: '' }),
    sayCopy('targetAfter', { goal: '' }),
    sayCopy('partialWeek', { label: '' }),
    sayCopy('partialMonth', { label: '' }),
    sayCopy('partialQuarter', { label: '' }),
    sayCopy('showSeries'),
    sayCopy('allSeries'),
    sayCopy('linesSummary', { count: 0, points: 0, names: '' }),
  ];
};
