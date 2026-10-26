/**
 * An App record's page, for a host that is not a route: the record dialog and
 * a split's detail pane. Reads go through the record surface, whose owner
 * fences every reply; writes and commands report to the host through
 * PageView's `host`, never the walk. The host remounts it per record (a
 * `key`), so one record's actions, drafts and delete state never reach the
 * next.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rowLabel } from '@mistriwork/kit/client/core.js';
import { applyingStaged, subscribeStaged, stagedVersion } from '@mistriwork/kit/client/write.js';
import { updateAttempts } from '@mistriwork/kit/client/updateAttempts.js';
import { commandOperations } from '../commandState.js';
import { refreshRecordInPlace } from '@mistriwork/kit/client/recordWriteRefresh.js';
import { PageView } from '@mistriwork/kit/client/components/Page.js';
import type { DeleteState } from '@mistriwork/kit/client/components/DeleteButton.js';
import {
  RECORD_REFRESH_FAILED,
  useRecordSurface,
  type RecordSurfaceEntry,
  type RecordSurfaceOwner,
} from '@mistriwork/kit/client/components/recordSurface.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { say } from '../copy/record/components/RecordPageBody.js';
import { refreshDecisions } from './decisionAdornment.js';

export type PageSections = PageDef['sections'];

interface RecordPageBodyProps {
  owner: RecordSurfaceOwner;
  tableId: string;
  recordKey: Record<string, unknown>;
  label?: string;
  pageId: string;
  close: () => void;
  /** Install synchronously before controls can dispatch. */
  setPendingProbe: (probe: () => boolean) => void;
  onName: (name: string) => void;
  /** Called once the record's page has something to show — its fields, or why it has none. */
  onSettled: () => void;
  /** The host's sections in place of the page's own: a split's authored `detail.show`, as one fields section. */
  sections?: PageSections;
  /** Only the page's own sections of this kind, and no head: a free-form page's `<Timeline>` (sdk/blocks.tsx). */
  only?: string;
}

export function RecordPageBody({
  owner,
  tableId,
  recordKey,
  label,
  pageId,
  close,
  setPendingProbe,
  onName,
  onSettled,
  sections,
  only,
}: RecordPageBodyProps) {
  const [tab, setTab] = useState<string>();
  const [name, setName] = useState(label);
  const entry = useMemo<RecordSurfaceEntry>(
    () => ({ kind: 'page', pageId, table: tableId, key: recordKey, label: name, tab }),
    [pageId, tableId, recordKey, name, tab],
  );
  const { result, rootRow } = useRecordSurface({ owner, entry });
  const client = useQueryClient();
  useSyncExternalStore(subscribeStaged, stagedVersion, stagedVersion);
  useSyncExternalStore(updateAttempts.subscribe, updateAttempts.version, updateAttempts.version);
  useSyncExternalStore(commandOperations.subscribe, commandOperations.version, commandOperations.version);
  const deletion = useRef<DeleteState | undefined>(undefined);
  const [deleteStatus, setDeleteStatus] = useState<DeleteState>();
  const surfaced = result.status === 'ready' ? result.content : undefined;
  /* One page object per plan and per host sections: PageView keys its label
     ownership on the page it is given (recordSurface.ts), so a fresh spread
     every render would republish the label forever. With the host's sections
     the page's plans no longer line up by index; a fields section reads its
     own values. */
  /* `only` hides the rest rather than dropping them, so each plan still lines up with its section by index. */
  const page = useMemo(
    () =>
      surfaced && sections
        ? { ...surfaced.page, sections }
        : surfaced && only
          ? {
              ...surfaced.page,
              sections: surfaced.page.sections.map((section) => (section.kind === only ? section : { ...section, hidden: true })),
            }
          : surfaced?.page,
    [surfaced?.page, sections, only],
  );
  const content = surfaced && page ? { ...surfaced, page, plans: sections ? [] : surfaced.plans } : undefined;
  const settled = Boolean(content) || result.status === 'error' || result.status === 'missing';
  useEffect(() => {
    if (settled) onSettled();
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const actions = useRef(content?.actions);
  if (content) actions.current = content.actions;
  const pending = () =>
    owner.isCurrent() &&
    (applyingStaged() ||
      Boolean(updateAttempts.get({ connection: owner.connection, table: tableId, key: recordKey })) ||
      deletion.current === 'pending' ||
      deletion.current === 'uncertain' ||
      Boolean(
        actions.current?.list.some((action) => {
          if (!action.command) return false;
          const operation = commandOperations.get({
            connection: owner.connection,
            target: tableId,
            key: recordKey,
            command: action.command.id,
            commandVersion: action.command.version,
          });
          return operation?.phase === 'pending' || operation?.phase === 'unknown';
        }),
      ));
  useLayoutEffect(() => {
    setPendingProbe(pending);
  }, [owner, tableId, recordKey, setPendingProbe]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!content || !rootRow || !owner.isCurrent()) return;
    const said = rowLabel(content.base, rootRow) as string | null;
    if (said) setName(said);
  }, [rootRow, content?.base, owner]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = (fields: boolean) => {
    if (!owner.isCurrent()) return;
    // Keep the editor mounted. Save's confirmed overlay remains authoritative;
    // command completion/explicit refresh can request fresh field values.
    refreshRecordInPlace(client, { connection: owner.connection, table: tableId, key: recordKey, queryScope: owner.queryScope }, fields);
    // What a command wrote may have settled a suggestion, or filled its field.
    refreshDecisions(client, owner.connection, tableId);
  };
  if (result.status === 'retired') return null;
  if (result.status === 'error') return <p className="note">{result.message}</p>;
  if (result.status === 'missing') return <p className="note">{say('thisRecordIsNoLonger')}</p>;
  if (!content) return <p className="note">{say('common.reading')}</p>;
  return (
    <>
      {result.status === 'ready' && result.refreshFailed && (
        <p role="alert" className="note">
          {RECORD_REFRESH_FAILED}
        </p>
      )}
      {deleteStatus === 'uncertain' && <p role="alert">{say('theDeletionResultIsNotYet')}</p>}
      <PageView
        {...content}
        {...(only ? { bare: true } : {})}
        onLayout={() => {}}
        onLabel={(next) => {
          setName(next);
          onName(next);
        }}
        onTab={setTab}
        host={{
          owner,
          pendingBar: 'inline',
          onRecordChange: (opts) => {
            if (opts) refresh(opts.inPlace === false);
          },
          onActionDone: () => refresh(true),
          onDeleteStateChange: (status) => {
            deletion.current = status;
            setDeleteStatus(status);
          },
          onDeleted: () => {
            refresh(false);
            close();
          },
        }}
      />
    </>
  );
}
