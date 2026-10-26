import { useMemo } from 'react';
import type { AppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { useAppTargetLinks } from '../appTargetLinks.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { captureSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';

export interface AppTargetActionProps {
  label: string;
  to: AppTarget;
  /** Only a row returned through the source reader's current data transport. */
  row?: Readonly<Record<string, unknown>>;
  className?: string;
}

const CheckedAppTargetAction = onDemand(() => import('./CheckedAppTargetAction.js'), 'CheckedAppTargetAction', { quiet: true });

/** Bind only served fields. Authorization and the external address belong to the suite. */
export function AppTargetAction(props: AppTargetActionProps) {
  const scope = useAppTargetLinks();
  // Capture before the chunk arrives: loading must not adopt a retained row
  // into whichever context happens to be current when it finishes.
  const rowOwner = useMemo(() => captureSessionIdentity(), [props.row]);
  return scope && (!props.row || rowOwner === scope.owner) ? <CheckedAppTargetAction {...props} scope={scope} /> : null;
}
