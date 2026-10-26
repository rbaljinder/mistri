/** The placed form's receipt and retry controls. Loaded on demand; the operation
 * owner keeps unanswered attempts independently of this presentation's lifetime. */
import { useMemo, useSyncExternalStore } from 'react';
import { publicPlacementOperation, type PreparedPublicForm } from '../publicPlacement.js';
import { FormSurface } from './FormSurface.js';
import { Button } from '@mistriwork/ui/Button.js';
import { say } from '../copy/forms/components/PlacedFormSurface.js';

export function PlacedFormSurface({
  prepared,
  prefill,
  review,
  onDismiss,
}: {
  prepared: PreparedPublicForm;
  prefill?: string;
  review?: boolean;
  onDismiss?: () => void;
}) {
  const operation = useMemo(() => publicPlacementOperation(prepared), [prepared]);
  const state = useSyncExternalStore(operation.subscribe, operation.snapshot);
  const held = operation.prepared;
  const via = new URLSearchParams(window.location.search).get('via') ?? undefined;
  const recovery =
    state.phase === 'unknown' || (state.phase === 'pending' && state.message) ? (
      <div>
        <p className="form-page-failure" role="alert" tabIndex={-1}>
          {operation.canRecover() ? state.message : say('placementRecoveryExpired')}
        </p>
        <div className="form-actions">
          <Button
            intent="primary"
            onClick={() => void operation.check()}
            busy={state.phase === 'pending'}
            busyLabel={say('common.checking')}
            disabled={!operation.canRecover()}
          >
            {say('placementCheckResult')}
          </Button>
          {operation.canRetry() && (
            <Button
              intent="secondary"
              onClick={() => void operation.retry()}
              busy={state.phase === 'pending'}
              busyLabel={say('common.submitting')}
            >
              {say('placementRetry')}
            </Button>
          )}
          {onDismiss && (
            <Button intent="secondary" onClick={onDismiss}>
              {say('common.close')}
            </Button>
          )}
        </div>
      </div>
    ) : undefined;
  return (
    <FormSurface
      key={operation.placement.submission}
      form={held.form}
      appName={held.app.name}
      prefill={prefill}
      review={review}
      onDismiss={onDismiss}
      inDialog={Boolean(onDismiss)}
      // A reference input's choices, read as this tenant's visitor (the intake address the page was published with).
      visitor={{ app: held.app.id, ...(via ? { via } : {}) }}
      submit={operation.send}
      attempt={{
        submission: operation.placement.submission,
        values: operation.values,
        receipt: state.receipt,
        locked: state.phase !== 'ready',
        recovery,
        capture: operation.capture,
      }}
    />
  );
}
