import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { allowMutationExit, state, subscribeWalk, walkVersion, whenConnectionChanges } from '../core.js';
import { canInsert, formProps } from '../insert.js';
import { draftSchemaKey } from '../recordDrafts.js';
import { sessionIdentity, subscribeSessionIdentity } from '../sessionIdentity.js';
import { DiscardNewRecord, NewRecordForm, useRecordClose, type FormCuration, type NewRecordProps } from './NewRecord.js';
import { say } from '../copy/forms/components/QuickAdd.js';

interface QuickAddProps {
  table: TableMeta;
  form?: FormCuration;
  label?: string;
  onAdded: () => void;
}

/** A list-owned frame over the same form and request lifetime as New. */
export function QuickAdd(props: QuickAddProps) {
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  useSyncExternalStore(subscribeWalk, walkVersion, walkVersion);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  useEffect(() => {
    const stop = whenConnectionChanges(() => setConnectionGeneration((value) => value + 1));
    return () => {
      stop();
    };
  }, []);
  if (identity.mode === 'locked' || !canInsert(props.table, true)) return null;
  const owner = JSON.stringify([
    identity.epoch,
    state.activeConnection,
    connectionGeneration,
    location.href,
    props.table.id,
    draftSchemaKey(props.table),
    props.form,
  ]);
  return <QuickAddHost key={owner} {...props} />;
}

function QuickAddHost({ table, form, label, onAdded }: QuickAddProps) {
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState<NewRecordProps | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!opened && wasOpen.current) trigger.current?.focus();
    wasOpen.current = opened !== null;
  }, [opened]);
  return (
    <div className="quick-add" ref={host}>
      <button
        ref={trigger}
        type="button"
        className="ghost quick-add-trigger"
        hidden={opened !== null}
        aria-expanded={opened !== null}
        onClick={() => {
          if (opened || !host.current || !canInsert(table, true) || !allowMutationExit()) return;
          setOpened(
            formProps(
              table,
              form,
              host.current,
              () => setOpened(null),
              () => onAdded(),
              { app: true },
            ),
          );
        }}
      >
        {say('quickAdd', { label: label ?? humanName(table.name).toLowerCase() })}
      </button>
      {opened && <InlineForm {...opened} />}
    </div>
  );
}

function InlineForm(props: NewRecordProps) {
  const dismissal = useRecordClose(props.onCancel, props.canClose);
  return (
    <>
      <NewRecordForm
        {...props}
        compact
        onCancel={dismissal.close}
        onPendingChange={dismissal.change}
        onDiscardChange={dismissal.discardChange}
      />
      {dismissal.discard && <DiscardNewRecord onDone={dismissal.resolve} />}
    </>
  );
}
