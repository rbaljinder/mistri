/** Binding and checked resolution for an action whose source scope is available. */
import { useCallback, useMemo } from 'react';
import { bindAppTarget, parseAppTarget, type BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { resolveAppTargetLink, type AppTargetLinksScope } from '../appTargetLinks.js';
import type { AppTargetActionProps } from './AppTargetAction.js';
import { AppTargetLink } from './AppTargetLink.js';

/** The authored action is checked only where its source scope is available. */
export function CheckedAppTargetAction({ label, to, row, className, scope }: AppTargetActionProps & { scope: AppTargetLinksScope }) {
  const target = useMemo(() => {
    try {
      return row ? bindAppTarget(to, row, Object.keys(row)) : (parseAppTarget(to) as BoundAppTarget);
    } catch {
      return null;
    }
  }, [to, row]);
  const resolve = useCallback((bound: BoundAppTarget, signal: AbortSignal) => resolveAppTargetLink(scope, bound, signal), [scope]);
  return target ? <AppTargetLink label={label} target={target} scope={scope.key} resolve={resolve} className={className} /> : null;
}
