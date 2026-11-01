/**
 * The assistant's conversations, one list for the room's rail and the panel's
 * Conversations view (AssistantPanel.tsx): what needs the person first — a
 * change waiting for them to confirm — then the rest by when they were last
 * touched, a quiet line each.
 *
 * Search is two answers to one box. Titles are filtered as the person types,
 * from the list already here; a moment after they stop, the server is asked
 * for the conversations whose words hold it (`/api/assistant/search` — theirs
 * and the model's, never a tool's result, and only their own), and those
 * come back with the line they were found in.
 *
 * Nothing here moves on its own: a turn still running is a word in the faint
 * ink where the time would be, not a pulse (docs/design.md, motion).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { assistantApi, assistantOwner } from './assistantRequest.js';
import { formatLocale, formatTimezone } from '@mistriwork/kit/client/locale.js';
import { Button } from '@mistriwork/ui/Button.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { say } from '../copy/shell/components/ConversationList.js';

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  /** `awaiting`: a change the model proposed is waiting for the person. */
  state?: 'idle' | 'awaiting';
  /** The line a search found it by. */
  snippet?: string;
}

interface ListProps {
  app: string;
  conversations: readonly ConversationSummary[];
  current: string | null;
  /** The conversation whose turn is running here, if one is. */
  working?: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** The clock the groups are read against; the browser's, but a test's own. */
  now?: Date;
}

const DAY = 86_400_000;

type Group = 'waiting' | 'today' | 'yesterday' | 'week' | 'older';
const GROUPS: readonly Group[] = ['waiting', 'today', 'yesterday', 'week', 'older'];

const headingOf = (group: Group): string =>
  ({
    waiting: say('group_waiting'),
    today: say('group_today'),
    yesterday: say('group_yesterday'),
    week: say('group_week'),
    older: say('group_older'),
  })[group];

/* The App's zone when it names one this runtime knows (`ui.timezone`, which the payload always fills), else the
   reader's own: "today" is the day the App's dates already mean, as formatRelativeDay reads it (locale.ts). */
const zones = new Map<string, Intl.DateTimeFormat>();
function dayParts(zone: string | undefined): Intl.DateTimeFormat {
  const key = zone ?? '';
  let format = zones.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' });
    zones.set(key, format);
  }
  return format;
}
function zoneOf(): string | undefined {
  const zone = formatTimezone();
  if (!zone) return undefined;
  try {
    dayParts(zone);
    return zone;
  } catch {
    return undefined;
  }
}
/** The calendar day an instant falls on in `zone`, as a UTC midnight: a ruler for counting days, never a moment. */
function dayOn(at: Date, zone: string | undefined): number {
  const parts = dayParts(zone).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'));
}
/** How many calendar days before today (in the App's zone) a conversation was last touched; NaN for no date. */
function daysBefore(updatedAt: string, now: Date, zone: string | undefined): number {
  const at = new Date(updatedAt);
  if (!Number.isFinite(at.getTime()) || !Number.isFinite(now.getTime())) return Number.NaN;
  return Math.round((dayOn(now, zone) - dayOn(at, zone)) / DAY);
}

/** Which heading a conversation sits under: waiting first, then by its last change's calendar day. */
function groupOf(conversation: ConversationSummary, now: Date, zone: string | undefined): Group {
  if (conversation.state === 'awaiting') return 'waiting';
  const days = daysBefore(conversation.updatedAt, now, zone);
  if (!(days > 0)) return Number.isNaN(days) ? 'older' : 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  return 'older';
}

/** Its day, said as the headings say days: "Today", "Yesterday", a weekday within the week, then the date ("Sep 4"). */
function dayLabel(updatedAt: string, now: Date, zone: string | undefined): string {
  const days = daysBefore(updatedAt, now, zone);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return say('day_today');
  if (days === 1) return say('day_yesterday');
  const at = new Date(updatedAt);
  const locale = formatLocale();
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: zone }).format(at);
  const sameYear = new Date(dayOn(at, zone)).getUTCFullYear() === new Date(dayOn(now, zone)).getUTCFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: zone,
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(at);
}

/** The time the list is read against: the browser's, read afresh each render and at least each minute, so a list
    left open over midnight moves its rows to Yesterday. A test passes its own. */
function useNow(given: Date | undefined): Date {
  const [, tick] = useState(0);
  useEffect(() => {
    if (given) return;
    const every = window.setInterval(() => tick((was) => was + 1), 60_000);
    return () => window.clearInterval(every);
  }, [given]);
  return given ?? new Date();
}

/** The words a search found, marked where they are. */
function Marked({ text, words }: { text: string; words: string }) {
  const at = words ? text.toLowerCase().indexOf(words.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + words.length)}</mark>
      {text.slice(at + words.length)}
    </>
  );
}

/* A funnel: the rail's box narrows this list, and is not the App's search. */
function Funnel() {
  return (
    <svg
      className="assistant-convs-find-icon"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <path d="M2.5 3.5h11l-4.25 5v4l-2.5 1v-5z" />
    </svg>
  );
}

function Plus() {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function ConversationList({ app, conversations, current, working, onOpen, onNew, onRename, onDelete, now: given }: ListProps) {
  const now = useNow(given);
  const zone = zoneOf();
  const [words, setWords] = useState('');
  const [asked, setAsked] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const term = words.trim();

  /* The server is asked once the person stops typing for a moment; titles answer at once meanwhile. */
  useEffect(() => {
    const wait = window.setTimeout(() => setAsked(term), 250);
    return () => window.clearTimeout(wait);
  }, [term]);
  const searched = useQuery({
    queryKey: ['assistant-search', app, assistantOwner(), asked],
    enabled: asked.length > 0,
    staleTime: 10_000,
    queryFn: async () =>
      (await assistantApi(`/api/assistant/search?app=${encodeURIComponent(app)}&q=${encodeURIComponent(asked)}`)) as {
        conversations: ConversationSummary[];
      },
  });

  const shown = useMemo(() => {
    if (!term) return conversations;
    const lower = term.toLowerCase();
    const found = asked === term ? (searched.data?.conversations ?? []) : [];
    const snippets = new Map(found.map((each) => [each.id, each.snippet]));
    const byTitle = conversations
      .filter((each) => each.title.toLowerCase().includes(lower))
      .map((each) => ({ ...each, snippet: snippets.get(each.id) }));
    const seen = new Set(byTitle.map((each) => each.id));
    return [...byTitle, ...found.filter((each) => !seen.has(each.id))];
  }, [conversations, term, asked, searched.data]);

  const groups = useMemo(() => {
    const out = new Map<Group, ConversationSummary[]>();
    for (const each of shown) {
      const group = groupOf(each, now, zone);
      out.set(group, [...(out.get(group) ?? []), each]);
    }
    return GROUPS.filter((group) => out.has(group)).map((group) => ({ group, rows: out.get(group)! }));
    // Grouped again when the day turns, not each render: today's day is what the clock changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, zone, Number.isFinite(now.getTime()) ? dayOn(now, zone) : 0]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && words) {
      // The box empties first; the panel's own Escape is the next press's.
      event.preventDefault();
      event.stopPropagation();
      setWords('');
    }
  };
  const settling = Boolean(term) && (asked !== term || searched.isFetching);

  const row = (each: ConversationSummary): ReactNode => {
    const here = each.id === current;
    const waiting = each.state === 'awaiting';
    return (
      <li key={each.id} className={`assistant-conv${here ? ' assistant-conv-current' : ''}${waiting ? ' assistant-conv-waiting' : ''}`}>
        {renaming === each.id ? (
          <RenameField
            title={each.title}
            onDone={(title) => {
              setRenaming(null);
              if (title && title !== each.title) void onRename(each.id, title);
            }}
          />
        ) : (
          <button type="button" className="assistant-conv-open" aria-current={here ? 'true' : undefined} onClick={() => onOpen(each.id)}>
            <span className="assistant-conv-line">
              {waiting && <span className="assistant-conv-dot" aria-label={say('waitingShort')} role="img" />}
              <span className="assistant-conv-title" title={each.title || undefined}>
                <Marked text={each.title || say('untitled')} words={term} />
              </span>
              <span className="assistant-conv-when">{working === each.id ? say('workingShort') : dayLabel(each.updatedAt, now, zone)}</span>
            </span>
            {term && each.snippet && (
              <span className="assistant-conv-snippet">
                <Marked text={each.snippet} words={term} />
              </span>
            )}
          </button>
        )}
        {renaming !== each.id && (
          <DropMenu
            className="assistant-conv-menu"
            triggerClassName="assistant-conv-more"
            triggerTitle={say('conversationActions', { title: each.title })}
            triggerLabel={say('conversationActions', { title: each.title })}
            label="⋯"
            popupClassName="page-actions-popup"
            align="end"
          >
            <DropItem className="page-actions-item" onClick={() => setRenaming(each.id)}>
              {say('rename')}
            </DropItem>
            <DropItem className="page-actions-item" onClick={() => setDeleting(each)}>
              {say('delete')}
            </DropItem>
          </DropMenu>
        )}
      </li>
    );
  };

  return (
    <div className="assistant-convs">
      <div className="assistant-convs-head">
        <button type="button" className="assistant-convs-new" onClick={onNew}>
          <Plus />
          {say('newConversation')}
        </button>
        <div className="assistant-convs-find">
          <Funnel />
          <input
            type="search"
            className="assistant-convs-search"
            value={words}
            placeholder={say('filterConversations')}
            aria-label={say('filterConversations')}
            onChange={(event) => setWords(event.target.value)}
            onKeyDown={onSearchKey}
          />
          {words && (
            <button
              type="button"
              className="assistant-convs-clear"
              aria-label={say('clearSearch')}
              title={say('clearSearch')}
              onClick={() => setWords('')}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {conversations.length === 0 && !term ? (
        <p className="assistant-empty">{say('noConversations')}</p>
      ) : shown.length === 0 ? (
        <p className="assistant-empty" role="status">
          {settling ? '' : say('noMatches')}
        </p>
      ) : term ? (
        <ul className="assistant-conv-list" aria-label={say('searchResults')}>
          {shown.map(row)}
        </ul>
      ) : (
        groups.map(({ group, rows }) => (
          <section key={group} className="assistant-conv-group" aria-labelledby={`assistant-conv-${group}`}>
            <h3 id={`assistant-conv-${group}`} className="assistant-conv-heading">
              {headingOf(group)}
            </h3>
            <ul className="assistant-conv-list">{rows.map(row)}</ul>
          </section>
        ))
      )}
      {deleting && (
        <DeleteConversation
          conversation={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            void onDelete(id);
          }}
        />
      )}
    </div>
  );
}

/** The title, edited where it is drawn: Enter keeps it, Escape leaves it as it was. */
export function RenameField({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(title);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next === null ? null : next.replace(/\s+/g, ' ').trim().slice(0, 200));
  };
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <input
      ref={field}
      className="assistant-conv-rename"
      value={value}
      maxLength={200}
      aria-label={say('renameLabel', { title })}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

/* As a record's delete asks (DeleteButton.tsx): an App keeps no undo, so the person says so first. */
export function DeleteConversation({
  conversation,
  onClose,
  onConfirm,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<ModalHandle>(null);
  return (
    <Modal
      className="confirm"
      ref={dialog}
      onClose={onClose}
      fullscreen={false}
      ariaLabel={say('deleteConversation', { title: conversation.title })}
    >
      <h2>{say('deleteConversation', { title: conversation.title })}</h2>
      <p>{say('deleteConversationTerms')}</p>
      <div className="confirm-actions">
        <Button intent="secondary" onClick={() => dialog.current?.close()}>
          {say('common.cancel')}
        </Button>
        <Button intent="danger" onClick={onConfirm}>
          {say('delete')}
        </Button>
      </div>
    </Modal>
  );
}
