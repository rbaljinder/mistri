/**
 * The in-App assistant (docs/assistant.md): a panel beside the page, not over
 * it — the person keeps reading and clicking the App while it answers — and
 * the whole page on a phone, where there is no beside.
 *
 * What it draws is data. The model's words are plain text with three marks
 * (bold, code, a link), and a link is followed only to an address inside the
 * App; its tables, figures and charts are dashboard sections the server
 * validated, drawn by the dashboard's own components; a record is the
 * record's values in the record form's shape. Nothing the model writes is
 * markup.
 *
 * Nothing it proposes happens here unasked. A proposal is a card; Confirm
 * runs it through the path the record's own button uses — a fixed edit
 * through /api/update, a command through its form, a new record through the
 * New form filled in — under the same checks, and the outcome is told back
 * to the assistant, which carries on.
 *
 * What it shows can be acted on as the App's own screens are: a record's card
 * carries the record's bar (Actions.tsx), and a table's rows the list's row
 * menu — the same verbs, the same grants, the same forms. Those are the
 * person's clicks; the model never makes them. What came of one is told to
 * the conversation (`/api/assistant/acted`), so the model reads it next turn.
 *
 * One component, three places: the panel beside the page, the panel full
 * screen over the content (remembered per person), and the App's assistant
 * room (`placement: 'page'`, `/{app}/assistant`) with the conversations as a
 * rail. Its chunk is loaded when the trigger is first pressed
 * (AssistantTrigger.tsx), or the room is first opened (Content.tsx).
 */
import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppAction, AppCommandAction } from '../../shared/app.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { shown } from '@mistriwork/kit/client/addressMount.js';
import { activeApp } from '../appState.js';
import {
  api,
  columnLabel,
  currentEntry,
  findTable,
  go,
  humanName,
  labelPath,
  state,
  viewportBox,
  viewportSize,
  writeAllowed,
} from '@mistriwork/kit/client/core.js';
import { grantedActionIds, mayRunAny } from '@mistriwork/kit/client/actionGrants.js';
import { sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { syncHash } from '@mistriwork/kit/client/url.js';
import { pageBridge } from '@mistriwork/kit/client/uiBridge.js';
import { assistantEntry } from '../publicAddress.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { ActionBar, ActionOutcomes, type ActionOutcome as ActionOutcomeReport } from './Actions.js';
import { ASSISTANT_PAGE, dashViewKey, formViewKey, resourceOf } from '@mistriwork/kit/client/components/appRooms.js';
import { startersHere } from '../../shared/appAssistant.js';
import { rootMatches } from '@mistriwork/kit/client/components/pageModel.js';
import { formProps } from '@mistriwork/kit/client/insert.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { pathEqualityFilter, recordKey as checkedRecordKey } from '@mistriwork/kit/client/resourceRequests.js';
import { updateAttempts } from '@mistriwork/kit/client/updateAttempts.js';
import type { CommandOperation } from '../commandState.js';
import {
  applyEvent,
  cutAt,
  grouped,
  inside,
  stream,
  waitingProposal,
  wordsOf,
  type AssistantBlock,
  type Run,
  type PanelItem,
  type Proposal,
  type ProposalOutcome,
  type StreamEvent,
} from './assistantStream.js';
import { Button } from '@mistriwork/ui/Button.js';
import { assistantApi, assistantOwner } from './assistantRequest.js';
import { ConversationList, DeleteConversation, RenameField, type ConversationSummary } from './ConversationList.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { CommandForm } from './CommandForm.js';
import { mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { NewRecordDialog } from '@mistriwork/kit/client/components/NewRecord.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { useWalk } from '@mistriwork/kit/client/components/walk.js';
import { RefJump, Value } from '@mistriwork/kit/client/components/Value.js';
import { referenceProjection } from '@mistriwork/engine/shared/referenceModel.js';
import type { DashboardDef } from '@mistriwork/kit/client/components/dashboardModel.js';
import { say } from '../copy/shell/components/AssistantPanel.js';
import './AssistantPanel.css';
import { addHostListener, navFollow, portalRoot, removeHostListener, shellById } from '@mistriwork/kit/client/shellHost.js';

const Dashboard = onDemand(() => import('./Dashboard.js'), 'Dashboard');

type Summary = ConversationSummary;

/* Where the person was, kept while the page is: closing the panel and opening it again returns to the same conversation. */
/* The panel reopens on the conversation it last showed, for the person and in the customer it was shown to. */
let lastConversation: { owner: string; id: string | null } = { owner: '', id: null };

const LIST_QUERY = 'assistant-conversations';
const phone = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;

/** An address inside the App, followed without a reload: the shell's own navigation listener paints it. */
function follow(address: string): void {
  navFollow(shown(address));
}

/** Follows an inside link in the page; a modified click is the browser's (a new tab). */
function Link({ to, children, onFollow }: { to: string; children: ReactNode; onFollow: (address: string) => void }) {
  return (
    <a
      href={shown(to)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onFollow(to);
      }}
    >
      {children}
    </a>
  );
}

/** The model's words, drawn from their runs (assistantStream.ts `wordsOf`). */
function Words({ text, onFollow }: { text: string; onFollow: (address: string) => void }) {
  const draw = (runs: Run[]) =>
    runs.map((run, at) =>
      'link' in run ? (
        <Link key={at} to={run.link} onFollow={onFollow}>
          {run.text}
        </Link>
      ) : run.mark === 'strong' ? (
        <strong key={at}>{run.text}</strong>
      ) : run.mark === 'code' ? (
        <code key={at}>{run.text}</code>
      ) : (
        run.text
      ),
    );
  return (
    <>
      {wordsOf(text).map((paragraph, p) =>
        paragraph.list ? (
          <ul key={p}>
            {paragraph.lines.map((line, l) => (
              <li key={l}>{draw(line)}</li>
            ))}
          </ul>
        ) : (
          <p key={p}>{paragraph.lines.flatMap((line, l) => (l ? [<br key={`br${l}`} />, ...draw(line)] : draw(line)))}</p>
        ),
      )}
    </>
  );
}

/** Whether the App's list over a table offers a menu on each row (`rowActions`): a chat table of it offers the same. */
/* A table drawn here offers its rows' menus where one of the App's views over it does, and only to a reader with a verb to run. */
function rowActionsOn(tableId: unknown): boolean {
  const app = activeApp() as AppPayloadApp | null;
  if (typeof tableId !== 'string') return false;
  return (
    Object.values(app?.views ?? {}).some(
      (view) => (view as { table?: string; rowActions?: true }).table === tableId && (view as { rowActions?: true }).rowActions === true,
    ) && mayRunAny(app, tableId, (resourceOf(app, tableId)?.actions ?? []) as AppAction[])
  );
}

/** A block the server validated, drawn by the App's own components. */
function Block({ block, onFollow }: { block: AssistantBlock; onFollow: (address: string) => void }) {
  const dashboard = useMemo(() => {
    if (block.kind !== 'section') return null;
    /* A table's rows open their records, and — where the App's list over the table offers it — carry the list's own row menu. */
    const section =
      block.section.kind === 'rows' && rowActionsOn(block.section.table) ? { ...block.section, rowActions: true } : block.section;
    return { id: 'assistant', label: String(section.title ?? ''), sections: [section] } as unknown as DashboardDef;
  }, [block]);
  if (dashboard) {
    return (
      <div className="assistant-block assistant-section">
        <Dashboard dashboard={dashboard} />
      </div>
    );
  }
  if (block.kind !== 'record') return null;
  return <RecordCard block={block} onFollow={onFollow} />;
}

/**
 * One record, as the peek card draws it, with the record's own bar under it:
 * the verbs its page would offer this person for its state now, each through
 * the page's own path (Actions.tsx), and Edit where they may write it — the
 * record's own form, in its dialog. After a verb the card reads the record
 * again, so it says what the record now is.
 */
/* A field on a record card: a reference by its record's name (as the glance
   draws it), a long single line cut with an ellipsis and its whole in the
   title (as the grid does), anything else as the record page says it. */
function CardValue({
  column,
  table,
  name,
  value,
  label,
  tableId,
  row,
}: {
  column: TableMeta['columns'][number] | undefined;
  table: TableMeta | undefined;
  name: string;
  value: unknown;
  label: unknown;
  tableId: string;
  row: Record<string, unknown>;
}) {
  if (column?.references && table && value !== null && value !== undefined && String(value) !== '')
    return <RefJump references={column.references} value={value} label={label} table={table} column={name} row={row} />;
  return <Value col={column} value={value} tableId={tableId} compact links={false} />;
}

function RecordCard({ block, onFollow }: { block: Extract<AssistantBlock, { kind: 'record' }>; onFollow: (address: string) => void }) {
  const app = activeApp() as AppPayloadApp | null;
  const table = findTable(block.table) as TableMeta | undefined;
  const queryClient = useQueryClient();
  const connection = state.activeConnection ?? undefined;
  const actions = (resourceOf(app, block.table)?.actions ?? []) as AppAction[];
  const editable = Boolean(table) && writeAllowed(block.table);
  const runnable = mayRunAny(app, block.table, actions);
  /* The card reads its record the way a glance does (PeekPanel): the fields
     it shows plus each reference's name, one row by its key. An action or an
     edit invalidates every query, this one with them, so the card re-reads
     to what the record is now. Until the read lands it says what the tool said. */
  const names = Object.keys(block.values);
  const projection = table ? referenceProjection(state.schema, table, names, true, labelPath) : undefined;
  const read = useQuery<Record<string, unknown> | null>({
    queryKey: ['assistant-record', connection ?? '', block.table, JSON.stringify(block.key)],
    enabled: Boolean(table && projection),
    queryFn: async () => {
      const data = (await api('/api/view/run', {
        view: {
          id: `assistant:${block.table}`,
          name: table!.name,
          base: table!.id,
          columns: projection!.fetched.map((path) => ({ path })),
          filter: pathEqualityFilter(block.key),
          limit: 1,
        },
      })) as { rows?: Array<Record<string, unknown>> };
      return data.rows?.[0] ?? null;
    },
    retry: false,
  });
  const row = read.data ?? undefined;
  const values = row
    ? Object.fromEntries(names.map((name) => [name, Object.hasOwn(row, name) ? row[name] : block.values[name]]))
    : block.values;
  const refLabel = (name: string) => {
    const at = projection?.labels.get(name);
    return row && at !== undefined ? row[at] : undefined;
  };
  const reread = () => void queryClient.invalidateQueries();
  // Big ids arrive as strings and stay strings (CLAUDE.md, values that are not numbers).
  const columns = table?.columns ?? [];
  const fields = Object.entries(values)
    .filter(([name]) => !columns.find((column) => column.name === name)?.primaryKey)
    .slice(0, 10);
  return (
    <div className="assistant-block assistant-record">
      <div className="assistant-record-title">
        {block.address && inside(block.address) ? (
          <Link to={block.address} onFollow={onFollow}>
            {block.title}
          </Link>
        ) : (
          block.title
        )}
      </div>
      <dl className="peekpanel-fields">
        {fields.map(([name, value]) => (
          <div className="field" key={name}>
            <dt>{columnLabel(block.table, name) ?? humanName(name)}</dt>
            <dd title={typeof value === 'string' && !columns.find((column) => column.name === name)?.references ? value : undefined}>
              <CardValue
                column={columns.find((column) => column.name === name)}
                table={table}
                name={name}
                value={value}
                label={refLabel(name)}
                tableId={block.table}
                row={values}
              />
            </dd>
          </div>
        ))}
      </dl>
      {table && (editable || runnable) && (
        <div className="assistant-record-actions" role="group" aria-label={say('recordActions', { label: block.title })}>
          {actions.length > 0 && (
            <ActionBar
              tableId={block.table}
              actions={actions}
              recordKey={block.key}
              label={block.title}
              matches={(when) => rootMatches(table, block.key, when, connection)}
              canUpdate={writeAllowed(block.table)}
              grantedCommands={app?.grantedCommands ?? []}
              grantedActions={grantedActionIds(app, block.table)}
              onDone={reread}
            />
          )}
          {editable && pageBridge.openPeek && (
            <Button
              className="page-action"
              aria-label={say('editRecordLabel', { label: block.title })}
              onClick={() => pageBridge.openPeek!(block.table, { ...block.key }, block.title, 'modal')}
            >
              {say('editRecord')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Steps({ steps, running }: { steps: Extract<PanelItem, { type: 'step' }>[]; running?: string }) {
  return (
    <details className="assistant-steps">
      <summary>{running ?? say('steps', { count: steps.length })}</summary>
      <ol>
        {steps.map((step) => (
          <li key={step.id} className={step.failed ? 'assistant-step-failed' : undefined}>
            {step.label}
          </li>
        ))}
      </ol>
    </details>
  );
}

const outcomeWords = (outcome: ProposalOutcome) =>
  outcome.status === 'done'
    ? say('applied')
    : outcome.status === 'declined'
      ? say('declined')
      : outcome.detail
        ? say('failed', { detail: outcome.detail })
        : say('failedPlain');

interface CardProps {
  proposal: Proposal;
  outcome?: ProposalOutcome;
  live: boolean;
  onResolve: (outcome: ProposalOutcome) => void;
  onFollow: (address: string) => void;
}

/** A proposed change: what, to which record, and why — and nothing done until Confirm. */
function ProposalCard({ proposal, outcome, live, onResolve, onFollow }: CardProps) {
  const app = activeApp() as AppPayloadApp | null;
  const action = (app?.resources[proposal.resource]?.actions as AppAction[] | undefined)?.find((each) => each.id === proposal.action);
  const reasonColumn =
    action && !action.command && typeof (action as { reason?: unknown }).reason === 'string'
      ? (action as { reason: string }).reason
      : undefined;
  const [reason, setReason] = useState(() =>
    reasonColumn && typeof proposal.values[reasonColumn] === 'string' ? String(proposal.values[reasonColumn]) : '',
  );
  const [busy, setBusy] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const queryClient = useQueryClient();
  const settled = (result: ProposalOutcome) => {
    setBusy(false);
    if (result.status === 'done') void queryClient.invalidateQueries();
    onResolve(result);
  };

  const confirmSet = async () => {
    if (!action || action.command || !proposal.key) return settled({ status: 'failed', detail: say('failedPlain') });
    const values = {
      ...(action as { set: Record<string, string | number | boolean | null> }).set,
      ...(reasonColumn ? { [reasonColumn]: reason.trim() } : {}),
    };
    const owner = { connection: state.activeConnection ?? null, table: proposal.resource, key: { ...proposal.key } };
    setBusy(true);
    try {
      const key = checkedRecordKey(owner.key);
      const result = await updateAttempts.run(owner, values, () =>
        api('/api/update', { ...ownedBy(owner.connection), table: owner.table, key, values }),
      );
      settled(result.kind === 'applied' ? { status: 'done' } : { status: 'failed', detail: result.message });
    } catch (error) {
      settled({ status: 'failed', detail: error instanceof Error ? error.message : undefined });
    }
  };

  const confirmNew = () => {
    const table = findTable(proposal.resource);
    if (!table) return settled({ status: 'failed', detail: say('failedPlain') });
    const view = Object.values(app?.views ?? {}).find(
      (each) => (each as { table?: string; form?: unknown }).table === proposal.resource && (each as { form?: unknown }).form,
    ) as { form?: { defaults?: Record<string, unknown> } } | undefined;
    const form = { ...(view?.form ?? {}), defaults: { ...(view?.form?.defaults ?? {}), ...proposal.values } };
    const host = document.createElement('div');
    host.className = 'insert-host';
    portalRoot().append(host);
    let added = false;
    setBusy(true);
    const close = () => {
      unmount(host);
      host.remove();
      // The form closes before it reports what it added; a close with nothing added is the person stepping back.
      queueMicrotask(() => {
        if (!added) setBusy(false);
      });
    };
    mount(
      host,
      createElement(
        NewRecordDialog,
        formProps(
          table,
          form as never,
          host,
          close,
          () => {
            added = true;
            settled({ status: 'done' });
          },
          { app: true },
        ),
      ),
    );
  };

  const confirm = () => {
    if (proposal.kind === 'set') void confirmSet();
    else if (proposal.kind === 'command') setCommandOpen(true);
    else confirmNew();
  };
  const command = action?.command ? (action as AppCommandAction) : undefined;
  const values = Object.entries(proposal.values).filter(([name]) => name !== reasonColumn);
  return (
    <section className={`assistant-proposal${outcome ? ` assistant-proposal-${outcome.status}` : ''}`} aria-label={say('proposedChange')}>
      <div className="assistant-proposal-head">
        <span className="assistant-proposal-verb">
          {proposal.kind === 'new'
            ? say('newRecord', { resource: findTable(proposal.resource)?.name ?? proposal.resource })
            : proposal.label}
        </span>
        {proposal.record &&
          (proposal.address && inside(proposal.address) ? (
            <Link to={proposal.address} onFollow={onFollow}>
              {proposal.record}
            </Link>
          ) : (
            <span>{proposal.record}</span>
          ))}
      </div>
      {proposal.why && <p className="assistant-proposal-why">{proposal.why}</p>}
      {values.length > 0 && (
        <dl className="assistant-proposal-values">
          {values.map(([name, value]) => (
            <div key={name}>
              <dt>{columnLabel(proposal.resource, name) ?? humanName(name)}</dt>
              <dd>
                <Value
                  col={findTable(proposal.resource)?.columns.find((column) => column.name === name)}
                  value={value}
                  tableId={proposal.resource}
                  compact
                  links={false}
                />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {outcome ? (
        <p className="assistant-proposal-outcome">{outcomeWords(outcome)}</p>
      ) : live ? (
        <>
          {reasonColumn && (
            <label className="assistant-proposal-reason">
              <span>{columnLabel(proposal.resource, reasonColumn) ?? say('reason')}</span>
              <textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} />
            </label>
          )}
          <div className="assistant-proposal-actions">
            <Button intent="primary" onClick={confirm} disabled={busy || (reasonColumn !== undefined && !reason.trim())}>
              {proposal.kind === 'set' ? say('confirm') : say('review')}
            </Button>
            <Button onClick={() => settled({ status: 'declined' })} disabled={busy}>
              {say('decline')}
            </Button>
          </div>
        </>
      ) : null}
      {commandOpen && command && proposal.key && (
        <CommandForm
          action={command}
          owner={{
            connection: state.activeConnection ?? '',
            target: command.command.target,
            command: command.command.id,
            commandVersion: command.command.version,
            key: { ...proposal.key },
          }}
          label={proposal.record ?? proposal.label}
          initial={proposal.values}
          onDone={() => {}}
          onClose={(operation?: CommandOperation) => {
            setCommandOpen(false);
            if (operation?.phase === 'success') settled({ status: 'done' });
            else if (operation?.phase === 'error') settled({ status: 'failed', detail: operation.message });
          }}
        />
      )}
    </section>
  );
}

/* Full screen is a per-person preference, kept on this device: the panel opens the way it was last left. */
const expandedKey = (app: string) => `mistri.assistant.expanded.${app}.${sessionIdentity().accountId ?? 'local'}`;
function readExpanded(app: string): boolean {
  try {
    return window.localStorage.getItem(expandedKey(app)) === '1';
  } catch {
    return false;
  }
}
function writeExpanded(app: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(expandedKey(app), '1');
    else window.localStorage.removeItem(expandedKey(app));
  } catch {
    /* Remembered where the browser lets it be; the panel works either way. */
  }
}

/** Whether the screen is a phone's, kept current as it turns or resizes. */
function usePhone(): boolean {
  const [on, setOn] = useState(phone);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 640px)');
    const changed = () => setOn(query.matches);
    query.addEventListener?.('change', changed);
    return () => query.removeEventListener?.('change', changed);
  }, []);
  return on;
}

/* Full screen's mark, drawn here so it rides this chunk and nothing of it is in a first page: corners out, or back in. */
function Corners({ inward }: { inward: boolean }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path
        d={inward ? 'M6 2.5V6H2.5M10 2.5V6h3.5M13.5 10H10v3.5M2.5 10H6v3.5' : 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'}
      />
    </svg>
  );
}

/* The room's Conversations control on a phone: a pane with its list at the side, drawn here so it rides this chunk. */
function ListMark() {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
      <path d="M6.25 2.75v10.5" />
    </svg>
  );
}

/* The composer grows with what is typed, from one line to about eight, then scrolls. */
const COMPOSE_MAX = 192;

interface AssistantProps {
  app: string;
  /** The App lets the assistant read the open record as the turn's context. */
  record: boolean;
  /** Beside the page (the trigger's), or the App's assistant room. */
  mode: 'panel' | 'page';
  /** The panel's close; the room has none, it is left as any room is. */
  onClose?: () => void;
  /** The room's conversation, from its address; the panel keeps the last one it showed. */
  conversation?: string;
}

/** The trigger's panel, beside the page or full screen over its content. */
export function AssistantPanel({ app, record, onClose }: { app: string; record: boolean; onClose: () => void }) {
  // Another customer, or another person, is another history: the panel starts again in it.
  return <Assistant key={assistantOwner()} app={app} record={record} mode="panel" onClose={onClose} />;
}

/** The App's assistant room (`placement: 'page'`), on the conversation its address names. */
export function AssistantRoom({ conversation }: { conversation?: string }) {
  const app = activeApp() as AppPayloadApp | null;
  if (!app?.assistant?.page) return null;
  return (
    <Assistant key={`${assistantOwner()}\n${conversation ?? ''}`} app={app.id} record={false} mode="page" conversation={conversation} />
  );
}

function Assistant({ app, record, mode, onClose, conversation: addressed }: AssistantProps) {
  const room = mode === 'page';
  const owner = assistantOwner();
  const [conversation, setConversation] = useState<string | null>(
    room ? (addressed ?? null) : lastConversation.owner === owner ? lastConversation.id : null,
  );
  const [started, setStarted] = useState<string | null>(null);
  const [items, setItems] = useState<PanelItem[]>([]);
  const [listing, setListing] = useState(false);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | undefined>();
  /* What went wrong, and the way on from it: `again` for a turn cut off on the way, `fresh` for a conversation this
     person may not open (a field report's panel stayed blank over a 403 it never said). */
  const [problem, setProblem] = useState<{ text: string; again?: true; fresh?: true } | null>(null);
  /* The last turn sent, and whether the server had kept the person's words before it was cut off: kept, it is retried
     from them; not, the same request is sent again. */
  const sent = useRef<{ path: '/api/assistant/turn' | '/api/assistant/resolve'; request: Record<string, unknown>; kept: boolean } | null>(
    null,
  );
  const [withRecord, setWithRecord] = useState(true);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [deletingOpen, setDeletingOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => !room && readExpanded(app));
  const onPhone = usePhone();
  const wide = room || (expanded && !onPhone);
  const stop = useRef<AbortController | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const frame = useRef<HTMLElement>(null);
  const queryClient = useQueryClient();
  const walk = useWalk();
  const top = walk[walk.length - 1];
  const context =
    record && (top?.kind === 'row' || top?.kind === 'page') && top.table && top.key
      ? { resource: top.table, key: top.key, label: top.label ?? top.table }
      : undefined;
  /* The App's starters for where the person is: its bare lines everywhere, a scoped one in its view's room or on a
     record of its table (appAssistant.ts). The room is the walk's top: a list's view, a dashboard's or a form's page. */
  const starters = startersHere((activeApp() as AppPayloadApp | null)?.assistant?.starters, {
    ...(top?.kind === 'table' && top.view ? { view: top.view } : {}),
    ...(top?.kind === 'page' && !top.key ? { view: dashViewKey(top.pageId) ?? formViewKey(top.pageId) } : {}),
    ...((top?.kind === 'row' || top?.kind === 'page') && top.table && top.key ? { record: top.table } : {}),
  });

  const conversations = useQuery({
    queryKey: [LIST_QUERY, app, owner],
    queryFn: async () =>
      (await assistantApi(`/api/assistant?app=${encodeURIComponent(app)}`)) as { conversations: Summary[]; ready: boolean },
  });
  const opened = useQuery({
    queryKey: ['assistant-conversation', app, owner, conversation],
    // Not the one this panel's own turn just started: its items are already here.
    enabled: conversation !== null && conversation !== started,
    staleTime: Infinity,
    queryFn: async () =>
      (await assistantApi(`/api/assistant/conversation?app=${encodeURIComponent(app)}&id=${encodeURIComponent(conversation!)}`)) as {
        items: PanelItem[];
      },
  });
  useEffect(() => {
    if (opened.data && Array.isArray(opened.data.items) && !busy) setItems(opened.data.items);
    // Only when a conversation is (re)opened: a live turn's items are the panel's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened.data]);
  useEffect(() => {
    if (!room) lastConversation = { owner, id: conversation };
  }, [room, conversation]);
  // A conversation that is gone (deleted in another tab, or another account's) starts a new one —
  // unless this panel's own turn has since answered for it. One refused is said, with the way out.
  useEffect(() => {
    if (!opened.isError || conversation === started) return;
    if ((opened.error as { status?: number } | null)?.status !== 404) {
      setProblem({ text: say('couldNotOpen', { message: opened.error.message }), fresh: true });
      return;
    }
    if (room) go(assistantEntry(), 'replace');
    else setConversation(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened.isError, room]);
  useEffect(() => () => stop.current?.abort(), []);
  useEffect(() => {
    box.current?.focus();
  }, [conversation, listing]);
  // The newest words stay in view while they arrive, unless the person has scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const view = body.current;
    if (view && pinned.current) view.scrollTop = view.scrollHeight;
  }, [items, running]);
  /* A block's rows, a card's fields and the composer's note arrive after the words do; a reader at the foot stays
     at the foot as they settle, rather than left reading whatever they pushed up. */
  useEffect(() => {
    const view = body.current;
    if (!view || typeof ResizeObserver !== 'function') return;
    const keep = new ResizeObserver(() => {
      if (pinned.current) view.scrollTop = view.scrollHeight;
    });
    keep.observe(view);
    for (const child of view.children) keep.observe(child);
    return () => keep.disconnect();
  }, [items]);

  /* The box is as tall as its words, to a limit: measured from its content each time they change. */
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = '';
    const natural = field.scrollHeight;
    if (!natural) return;
    field.style.height = `${Math.min(natural + field.offsetHeight - field.clientHeight, COMPOSE_MAX)}px`;
    field.style.overflowY = natural > COMPOSE_MAX ? 'auto' : 'hidden';
  }, [text]);

  /* Full screen fills the content column — beside the App's menu, never over it — and the page beneath does
     not move: the panel is fixed, and only its own left edge changes. Measured on the zoom-aware ruler. */
  useLayoutEffect(() => {
    const panel = frame.current;
    if (room || !panel) return;
    if (!wide) {
      panel.style.removeProperty('--assistant-left');
      return;
    }
    const place = () => {
      const content = shellById('content');
      panel.style.setProperty('--assistant-left', `${content ? Math.max(0, Math.round(viewportBox(content).left)) : 0}px`);
    };
    place();
    addHostListener(window, 'resize', place);
    return () => removeHostListener(window, 'resize', place);
  }, [room, wide]);
  /* The room stands from where it begins to the foot of the window, so the composer sits at the bottom. */
  useLayoutEffect(() => {
    const panel = frame.current;
    if (!room || !panel) return;
    const fit = () => {
      panel.style.height = `${Math.max(320, Math.floor(viewportSize().height - viewportBox(panel).top))}px`;
    };
    fit();
    addHostListener(window, 'resize', fit);
    return () => removeHostListener(window, 'resize', fit);
  }, [room]);

  const toggleExpanded = () => {
    setExpanded((was) => {
      writeExpanded(app, !was);
      return !was;
    });
  };

  /* A conversation this room's own turn started: the address says it from now on, without leaving the room. */
  const adopt = (id: string) => {
    setStarted(id);
    setConversation(id);
    if (!room) return;
    const here = currentEntry() as { kind?: string; pageId?: string; tab?: string } | undefined;
    if (here?.kind === 'page' && here.pageId === ASSISTANT_PAGE && here.tab !== id) {
      here.tab = id;
      syncHash();
    }
  };

  const run = useCallback(
    async (path: '/api/assistant/turn' | '/api/assistant/resolve', request: Record<string, unknown>) => {
      const controller = new AbortController();
      stop.current = controller;
      const turn = { path, request, kept: false };
      sent.current = turn;
      setBusy(true);
      setProblem(null);
      /* Said at once and kept still: the server reads the App and the catalog before its first event, and a field
         report waited seventy seconds under a bare question. Then each tool says what it is doing as it runs. */
      setRunning(say('working'));
      pinned.current = true;
      try {
        await stream(
          path,
          { app, ...request },
          (event: StreamEvent) => {
            if (event.event === 'conversation' && typeof event.data.id === 'string') adopt(event.data.id);
            if (event.event === 'conversation' && typeof event.data.person === 'number') turn.kept = true;
            if (event.event === 'running') setRunning(typeof event.data.label === 'string' ? event.data.label : say('working'));
            // Between steps the model is at work again; once it writes, its words are the sign.
            if (event.event === 'step') setRunning(say('working'));
            if (event.event === 'text' || event.event === 'done') setRunning(undefined);
            if (event.event === 'error' && typeof event.data.message === 'string')
              setProblem({ text: say('couldNotAnswer', { message: event.data.message }) });
            setItems((now) => applyEvent(now, event));
          },
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setProblem(
            (error as { lost?: boolean } | null)?.lost
              ? { text: say('connectionLost'), again: true }
              : { text: say('couldNotAnswer', { message: error instanceof Error ? error.message : String(error) }) },
          );
      } finally {
        if (controller.signal.aborted)
          setItems((now) => [...applyEvent(now, { event: 'done', data: {} }), { type: 'note', text: say('stopped') }]);
        stop.current = null;
        setBusy(false);
        setRunning(undefined);
        void queryClient.invalidateQueries({ queryKey: [LIST_QUERY, app] });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [app, queryClient, room],
  );

  const say_ = (said: string) => {
    if (!said || busy) return;
    let next = items;
    const request: Record<string, unknown> = { text: said, ...(conversation ? { conversation } : {}) };
    if (editing !== null) {
      const at = items.findIndex((item) => item.type === 'person' && item.seq === editing);
      if (at >= 0) next = cutAt(items, at);
      request.edit = editing;
    }
    if (context && withRecord) request.context = { resource: context.resource, key: context.key };
    setItems([...next, { type: 'person', text: said }]);
    setText('');
    setEditing(null);
    void run('/api/assistant/turn', request);
  };
  const send = () => say_(text.trim());
  const retry = () => {
    const at = items.map((item) => item.type).lastIndexOf('person');
    if (at < 0 || !conversation) return;
    setItems([...cutAt(items, at), items[at]]);
    void run('/api/assistant/turn', { conversation, text: (items[at] as { text: string }).text, retry: true });
  };
  /* A turn cut off on the way, tried again: from the person's words if the server kept them, else sent as it was. */
  const again = () => {
    const turn = sent.current;
    if (!turn || busy) return;
    if (turn.path === '/api/assistant/turn' && turn.kept && conversation) return retry();
    void run(turn.path, turn.request);
  };
  const resolve = (proposal: Proposal, outcome: ProposalOutcome) => {
    if (!conversation) return;
    setItems((now) => now.map((item) => (item.type === 'proposal' && item.id === proposal.id ? { ...item, outcome } : item)));
    void run('/api/assistant/resolve', {
      conversation,
      proposal: proposal.id,
      outcome: outcome.status,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    });
  };
  /* A verb the person ran from a card or a row here: told to the conversation, drawn as its note. */
  const live = useRef(conversation);
  live.current = conversation;
  const acted = useCallback(
    (report: { tableId: string; key: Record<string, unknown>; label: string; action: AppAction; outcome: ActionOutcomeReport }) => {
      const id = live.current;
      if (!id) return;
      void (async () => {
        try {
          const answer = (await assistantApi('/api/assistant/acted', {
            app,
            conversation: id,
            resource: report.tableId,
            action: report.action.id,
            key: report.key,
            record: report.label,
            outcome: report.outcome.status,
            ...(report.outcome.detail ? { detail: report.outcome.detail } : {}),
          })) as { item?: PanelItem };
          if (answer.item && live.current === id) {
            pinned.current = true;
            setItems((now) => [...now, answer.item!]);
          }
        } catch {
          /* The verb ran or did not on its own; only the conversation's note of it is missing. */
        }
      })();
    },
    [app],
  );
  const open = (id: string) => {
    stop.current?.abort();
    setListing(false);
    if (room) {
      go(assistantEntry(id), 'push');
      return;
    }
    setStarted(null);
    setConversation(id);
    void queryClient.invalidateQueries({ queryKey: ['assistant-conversation', app, owner, id] });
  };
  const startNew = () => {
    stop.current?.abort();
    setListing(false);
    if (room) {
      if (conversation) go(assistantEntry(), 'push');
      return;
    }
    setConversation(null);
    setItems([]);
    setEditing(null);
    setProblem(null);
  };
  const remove = async (id: string) => {
    await assistantApi('/api/assistant/delete', { app, conversation: id });
    if (id === conversation) {
      if (room) go(assistantEntry(), 'replace');
      else startNew();
    }
    void queryClient.invalidateQueries({ queryKey: [LIST_QUERY, app] });
    void queryClient.invalidateQueries({ queryKey: ['assistant-search', app] });
  };
  const rename = async (id: string, title: string) => {
    // Drawn at once; the list read again says what the server kept.
    queryClient.setQueryData([LIST_QUERY, app, owner], (was: { conversations: Summary[]; ready: boolean } | undefined) =>
      was ? { ...was, conversations: was.conversations.map((each) => (each.id === id ? { ...each, title } : each)) } : was,
    );
    try {
      await assistantApi('/api/assistant/rename', { app, conversation: id, title });
    } finally {
      void queryClient.invalidateQueries({ queryKey: [LIST_QUERY, app] });
      void queryClient.invalidateQueries({ queryKey: ['assistant-search', app] });
    }
  };
  const onFollow = (address: string) => {
    follow(address);
    if (!room && (onPhone || wide)) onClose?.();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === 'ArrowUp' && !text) {
      // Up in an empty box takes the last thing said back to edit, as a chat does.
      const last = [...items].reverse().find((item): item is Extract<PanelItem, { type: 'person' }> => item.type === 'person');
      if (last?.seq !== undefined && !busy && !waitingProposal(items)) {
        event.preventDefault();
        setEditing(last.seq);
        setText(last.text);
      }
    }
  };
  const onPanelKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (busy) {
      event.preventDefault();
      stop.current?.abort();
    } else if (editing !== null) {
      event.preventDefault();
      setEditing(null);
      setText('');
    } else if (listing) {
      event.preventDefault();
      setListing(false);
    } else if (!room && wide) {
      // Full screen steps back to the side panel first, the focus where it was.
      event.preventDefault();
      toggleExpanded();
    } else if (!room) {
      event.preventDefault();
      onClose?.();
    }
  };

  const waiting = waitingProposal(items);
  const waitingNote = useId();
  const lastPerson = items.map((item) => item.type).lastIndexOf('person');
  const ready = conversations.data?.ready !== false;
  const drawn = grouped(items);
  const list = (
    <ConversationList
      app={app}
      conversations={conversations.data?.conversations ?? []}
      current={conversation}
      working={busy ? conversation : null}
      onOpen={open}
      onNew={startNew}
      onRename={rename}
      onDelete={remove}
    />
  );
  const Frame = room ? 'section' : 'aside';
  const Title = room ? 'h1' : 'h2';
  /* The room is headed by the conversation it shows, once it has one; a new one is the Assistant. */
  const titled = room && conversation ? conversations.data?.conversations.find((each) => each.id === conversation) : undefined;
  const heading = titled?.title || say('assistant');
  const starting = ready && items.length === 0 && !(conversation && opened.isPending);
  const canSend = Boolean(text.trim()) && ready && !waiting;
  return (
    <Frame
      ref={frame as never}
      id={room ? 'assistant-room' : 'assistant-panel'}
      className={`${room ? 'assistant-room' : 'assistant-panel'}${wide ? ' assistant-wide' : ''}${!room && wide ? ' assistant-panel-expanded' : ''}${room && listing ? ' assistant-room-listing' : ''}${(starting || !ready) && !(listing && !room) ? ' assistant-starting' : ''}`}
      {...(room ? {} : { role: 'complementary' })}
      aria-label={say('assistant')}
      onKeyDown={onPanelKey}
    >
      {room && (
        <nav className="assistant-rail" aria-label={say('conversations')}>
          {list}
        </nav>
      )}
      {/* On a phone the rail is a sheet over the conversation, which stays in sight; a press beside it closes it. */}
      {room && listing && <div className="assistant-rail-scrim" aria-hidden="true" onClick={() => setListing(false)} />}
      <div className="assistant-main">
        <div className="assistant-head">
          {/* The room's conversations on a phone, where the rail is a sheet: the head's first control, as a drawer's is. */}
          {room && (
            <button
              type="button"
              className="btn ghost btn-compact assistant-rail-toggle"
              aria-pressed={listing}
              title={say('conversations')}
              onClick={() => setListing((was) => !was)}
            >
              <ListMark />
              <span className="visually-hidden">{say('conversations')}</span>
            </button>
          )}
          {room && titled && renamingTitle ? (
            <RenameField
              title={titled.title}
              onDone={(title) => {
                setRenamingTitle(false);
                if (title && title !== titled.title) void rename(titled.id, title);
              }}
            />
          ) : (
            <Title className="assistant-title">
              <span className="assistant-title-words" title={titled ? heading : undefined}>
                {heading}
              </span>
            </Title>
          )}
          {room && titled && !renamingTitle && (
            <DropMenu
              className="assistant-title-menu"
              triggerClassName="assistant-conv-more"
              triggerTitle={say('conversationActions', { title: titled.title })}
              triggerLabel={say('conversationActions', { title: titled.title })}
              label="⋯"
              popupClassName="page-actions-popup"
              align="start"
            >
              <DropItem className="page-actions-item" onClick={() => setRenamingTitle(true)}>
                {say('rename')}
              </DropItem>
              <DropItem className="page-actions-item" onClick={() => setDeletingOpen(true)}>
                {say('delete')}
              </DropItem>
            </DropMenu>
          )}
          {!room && (
            <button type="button" className="icon-button" aria-pressed={listing} onClick={() => setListing((was) => !was)}>
              {say('conversations')}
            </button>
          )}
          {!room && !listing && (
            <button type="button" className="icon-button" onClick={startNew}>
              {say('newConversation')}
            </button>
          )}
          {!room && (
            <button
              type="button"
              className="icon-button assistant-expand"
              aria-pressed={expanded}
              aria-label={say('expand')}
              title={expanded ? say('collapse') : say('expand')}
              onClick={toggleExpanded}
            >
              <Corners inward={expanded} />
            </button>
          )}
          {!room && (
            <button type="button" className="peekpanel-close" aria-label={say('close')} title={say('close')} onClick={onClose}>
              ×
            </button>
          )}
        </div>
        {listing && !room ? (
          <div className="assistant-body">{list}</div>
        ) : (
          <ActionOutcomes.Provider value={acted}>
            <div
              className="assistant-body"
              ref={body}
              aria-live="polite"
              aria-busy={busy}
              onScroll={(event) => {
                const view = event.currentTarget;
                pinned.current = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
              }}
            >
              {!ready && <p className="assistant-empty">{say('noModel')}</p>}
              {starting && (
                <div className="assistant-start">
                  <p className="assistant-empty">{say('emptyHint')}</p>
                  {starters.length > 0 && (
                    <div className="assistant-starters" role="group" aria-label={say('starters')}>
                      {starters.map((starter) => (
                        <button key={starter} type="button" className="assistant-starter" disabled={busy} onClick={() => say_(starter)}>
                          {starter}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {drawn.map((entry, index) => {
                if (entry.type === 'steps')
                  return (
                    <Steps key={`s${entry.at}`} steps={entry.steps} running={busy && index === drawn.length - 1 ? running : undefined} />
                  );
                const { item, at } = entry;
                if (item.type === 'person')
                  return (
                    <div
                      key={`p${at}`}
                      className={`assistant-person${editing !== null && item.seq === editing ? ' assistant-person-editing' : ''}`}
                    >
                      <p>{item.text}</p>
                      {!busy && !waiting && (
                        <div className="assistant-person-tools">
                          {item.seq !== undefined && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditing(item.seq!);
                                setText(item.text);
                                box.current?.focus();
                              }}
                            >
                              {say('edit')}
                            </button>
                          )}
                          {at === lastPerson && conversation && (
                            <button type="button" onClick={retry}>
                              {say('retry')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                if (item.type === 'text')
                  return (
                    <div key={`t${at}`} className="assistant-text">
                      <Words text={item.text} onFollow={onFollow} />
                    </div>
                  );
                if (item.type === 'note')
                  return (
                    <p key={`n${at}`} className="assistant-note">
                      {item.text}
                    </p>
                  );
                if (item.type === 'block') return <Block key={`b${at}`} block={item.block} onFollow={onFollow} />;
                if (item.type === 'proposal')
                  return (
                    <ProposalCard
                      key={`c${item.id}`}
                      proposal={item.proposal}
                      outcome={item.outcome}
                      live={!busy && waiting?.id === item.id}
                      onResolve={(outcome) => resolve(item.proposal, outcome)}
                      onFollow={onFollow}
                    />
                  );
                return null;
              })}
              {busy && (drawn.length === 0 || drawn[drawn.length - 1].type !== 'steps') && running && (
                <p className="assistant-working">{running}</p>
              )}
              {problem && (
                <div className="assistant-problem" role="alert">
                  <p>{problem.text}</p>
                  {problem.again && !busy && (
                    <button type="button" onClick={again}>
                      {say('tryAgain')}
                    </button>
                  )}
                  {problem.fresh && (
                    <button type="button" onClick={startNew}>
                      {say('newConversation')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </ActionOutcomes.Provider>
        )}
        <div className="assistant-foot">
          {context && withRecord && !listing && (
            <div className="assistant-context">
              <span>{say('about', { label: context.label })}</span>
              <button
                type="button"
                className="ghost"
                aria-label={say('leaveOutRecord', { label: context.label })}
                title={say('leaveOutRecord', { label: context.label })}
                onClick={() => setWithRecord(false)}
              >
                ×
              </button>
            </div>
          )}
          {editing !== null && (
            <div className="assistant-context">
              <span>{say('editing')}</span>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setEditing(null);
                  setText('');
                }}
              >
                {say('cancelEdit')}
              </button>
            </div>
          )}
          {/* A change waiting for the person is said in the field itself, and the field says it is why it is shut. */}
          <div className="assistant-compose">
            {waiting && !busy && (
              <p className="assistant-waiting" id={waitingNote}>
                <span className="assistant-waiting-dot" aria-hidden="true" />
                {say('waitingForYou')}
              </p>
            )}
            <div className="assistant-compose-row">
              <textarea
                ref={box}
                rows={1}
                value={text}
                aria-label={say('message')}
                aria-describedby={waiting && !busy ? waitingNote : undefined}
                placeholder={say('message')}
                disabled={!ready || Boolean(waiting && !busy)}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKey}
              />
              {busy ? (
                <Button onClick={() => stop.current?.abort()}>{say('stop')}</Button>
              ) : (
                <Button intent={canSend ? 'primary' : 'secondary'} onClick={send} disabled={!canSend}>
                  {say('send')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      {deletingOpen && titled && (
        <DeleteConversation
          conversation={titled}
          onClose={() => setDeletingOpen(false)}
          onConfirm={() => {
            setDeletingOpen(false);
            void remove(titled.id);
          }}
        />
      )}
    </Frame>
  );
}
