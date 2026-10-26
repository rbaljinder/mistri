/**
 * Export's trigger, held: the control itself (Export.tsx), with its chooser,
 * serialisers and the agent hand-off, is a part that loads on demand, and
 * this is what stands in its place until it has — the same trigger, laid out
 * and unseen. The crumb bar is right-aligned, so a trigger arriving late
 * beside New would push New a button's width to the left. The part is asked
 * for as soon as a list is on its way, so it is usually here before the rows.
 */
import { useEffect, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { useCrumbSlots } from './crumbSlot.js';
import { onDemand, useArrived } from './onDemand.js';
import { say } from '../copy/workbench/components/Export.js';

const ExportPart = onDemand(() => import('./Export.js'), 'ExportControl', { quiet: true });

function HeldTrigger() {
  return (
    <div className="export" aria-hidden="true" inert style={{ visibility: 'hidden' }}>
      <button type="button" className="export-summary" tabIndex={-1}>
        <span className="export-word">{say('export')}</span>
        <span className="export-more">⋯</span>
      </button>
    </div>
  );
}

/** Export's place at the end of the crumb bar while the rows are on their way. */
export function ExportHold() {
  const { tools } = useCrumbSlots();
  useEffect(() => void ExportPart.ready(), []);
  if (!tools) return null;
  return createPortal(<HeldTrigger />, tools);
}

/** The Export control, or its held trigger until the part has arrived. */
export function ExportControl(props: ComponentProps<typeof ExportPart>) {
  return useArrived(ExportPart) ? <ExportPart {...props} /> : <HeldTrigger />;
}
