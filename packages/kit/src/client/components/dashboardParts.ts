/* Apart from dashboardModel.ts on purpose: ChartShapes.tsx reads that model, so the model naming the part it loads would
   be a loop of files (test/repo/runtime-cycles.test.ts). */
import { EXTRA_SHAPES, type DashboardDef } from './dashboardModel.js';

/**
 * Ask for the parts a dashboard's sections will draw the moment the dashboard is known, beside its own chunk (which
 * its room asks for as it draws). Each was asked by the section that draws it, once the dashboard's chunk had arrived
 * and drawn: an extra chart shape (ChartFigure.tsx) and a list's Export (ExportHold.tsx). The first page is unveiled
 * when nothing is still out (startupHold.ts), so that second round trip was the dashboard's LCP. Only a fetch: the
 * part still loads, counts and fails through its own `onDemand`, and none joins the first page's bundle.
 */
export function preloadDashboardParts(dashboard: Pick<DashboardDef, 'sections' | 'aside' | 'page'>): void {
  if (dashboard.page) return;
  if ([...dashboard.sections, ...(dashboard.aside ?? [])].some((section) => EXTRA_SHAPES.includes(section.shape ?? '')))
    import('./ChartShapes.js').catch(() => {});
  if (dashboard.sections.some((section) => section.kind === 'rows')) import('./Export.js').catch(() => {});
}
