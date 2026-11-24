/**
 * A funnel section (`funnel()`): delegates stage bar + basis/drop-off rendering to `@mistriwork/ui/charts.js`
 * while binding Mistri's localized funnel copy and locale percent formatting.
 */
import { FunnelSteps, type FunnelDoor, type FunnelStep } from '@mistriwork/ui/charts.js';
import { formatPercent } from '@mistriwork/kit/client/locale.js';
import { say as sayCopy } from '../copy/dashboards/components/Funnel.js';
import './Funnel.css';

export type { FunnelDoor, FunnelStep };

export function Funnel({
  steps,
  say,
  table,
  label,
}: {
  steps: FunnelStep[];
  /** How a count is said (the section's figure rule). */
  say: (value: unknown) => string;
  table: string;
  label?: string;
}) {
  return (
    <FunnelSteps
      steps={steps}
      formatValue={say}
      table={table}
      label={label}
      formatShare={(pct) => formatPercent(pct, { maximumFractionDigits: 0 })}
      words={{
        summary: (args) => sayCopy('summary', args),
        openReached: (args) => sayCopy('openReached', args),
        openDropped: (args) => sayCopy('openDropped', args),
        optional: sayCopy('optional'),
        ofBasis: (args) => sayCopy('ofBasis', args),
        dropped: (args) => sayCopy('dropped', args),
        droppedTitle: (args) => sayCopy('droppedTitle', args),
      }}
    />
  );
}
