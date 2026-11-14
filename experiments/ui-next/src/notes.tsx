import {
  ArrowClockwise,
  Eye,
  LinkSimple,
  ListBullets,
  PaperPlaneTilt,
  PencilSimple,
  Smiley,
  TextB,
  TextItalic,
} from '@phosphor-icons/react';
import { announce } from '@ui-sdk/core';
import { Textarea } from '@ui-sdk/react/textarea';
import { Toolbar, ToolbarButton } from '@ui-sdk/react/toolbar';
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { Avatar } from './display';
import { FieldFrame } from './fields';
import { DropMenu } from './overlays';
import { applyMark, continueList, type Edit, Prose, type ProseMark } from './prose';
import { words } from './words';

/* Writing a note, and reading the notes on a record. A note is plain text with a little shape (./prose.tsx), so
   the box it is written in is a textarea and nothing cleverer: a screen reader, a spell checker, a phone's
   keyboard and undo all know what to do with one. The marks are buttons over it and the keys a writer already
   has (Ctrl or Cmd with B, I and K), and a list goes on by itself on Enter. */

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl';

type AreaProps = {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  rows?: number;
  /* Ctrl or Cmd with Enter. */
  onSubmit?: () => void;
  /* What stands at the far end of the marks: a Send button. */
  end?: ReactNode;
  id?: string;
};

function NoteArea({ label, value, onValueChange, placeholder, disabled, name, rows = 3, onSubmit, end, id }: AreaProps) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const [reading, setReading] = useState(false);
  /* Where the selection goes once the new words are drawn: a controlled box would otherwise send it to the end. */
  const select = useRef<Edit | null>(null);
  useLayoutEffect(() => {
    const to = select.current;
    if (!to || !box.current) return;
    select.current = null;
    box.current.focus();
    box.current.setSelectionRange(to.start, to.end);
  });
  const edit = (next: Edit | undefined) => {
    if (!next) return;
    select.current = next;
    onValueChange(next.text);
  };
  const mark = (which: ProseMark) => {
    const el = box.current;
    if (el) edit(applyMark(value, el.selectionStart, el.selectionEnd, which));
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      onSubmit?.();
    } else if (mod && !event.altKey && ['b', 'i', 'k'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      mark(({ b: 'strong', i: 'emphasis', k: 'link' } as const)[event.key.toLowerCase() as 'b' | 'i' | 'k']);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
      const el = event.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return;
      const next = continueList(value, el.selectionStart);
      if (next) {
        event.preventDefault();
        edit(next);
      }
    }
  };
  const MARKS: { mark: ProseMark; label: string; icon: ReactNode }[] = [
    { mark: 'strong', label: `${words.bold} (${MOD}+B)`, icon: <TextB weight="bold" /> },
    { mark: 'emphasis', label: `${words.italic} (${MOD}+I)`, icon: <TextItalic weight="bold" /> },
    { mark: 'list', label: words.bulletList, icon: <ListBullets weight="bold" /> },
    { mark: 'link', label: `${words.link} (${MOD}+K)`, icon: <LinkSimple weight="bold" /> },
  ];
  return (
    <div data-slot="note-area" data-disabled={disabled ? '' : undefined}>
      {reading ? (
        <div data-slot="note-preview" aria-label={words.preview}>
          {value.trim() ? <Prose>{value}</Prose> : <p data-slot="note-nothing">{words.nothingToPreview}</p>}
        </div>
      ) : (
        <Textarea
          ref={box}
          id={id}
          name={name}
          aria-label={label}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          autoResize
          value={value}
          onValueChange={(next) => onValueChange(String(next))}
          onKeyDown={onKey}
        />
      )}
      <div data-slot="note-bar">
        <Toolbar aria-label={words.formatting}>
          {MARKS.map((one) => (
            <ToolbarButton
              key={one.mark}
              type="button"
              data-slot="note-mark"
              aria-label={one.label}
              title={one.label}
              disabled={disabled || reading}
              // A press on a mark is not a press out of the box: what was selected stays selected.
              onMouseDown={(press) => press.preventDefault()}
              onClick={() => mark(one.mark)}
            >
              {one.icon}
            </ToolbarButton>
          ))}
          <ToolbarButton
            type="button"
            data-slot="note-mark"
            aria-pressed={reading}
            aria-label={reading ? words.write : words.preview}
            title={reading ? words.write : words.preview}
            disabled={disabled}
            onClick={() => setReading((now) => !now)}
          >
            {reading ? <PencilSimple weight="bold" /> : <Eye weight="bold" />}
          </ToolbarButton>
        </Toolbar>
        {end}
      </div>
    </div>
  );
}

export type NoteFieldProps = {
  label: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
};

/* A longer answer with a little shape, as a form's field: the marks over a textarea, and what it will read as a
   press away. What the form is sent is the text as written. */
export function NoteField({
  label,
  name,
  value,
  defaultValue = '',
  onValueChange,
  hint,
  error,
  required,
  optional,
  disabled,
  placeholder,
  rows = 4,
}: NoteFieldProps) {
  const [own, setOwn] = useState(defaultValue);
  const text = value === undefined ? own : value;
  return (
    <FieldFrame label={label} name={name} hint={hint} error={error} required={required} optional={optional} disabled={disabled}>
      <NoteArea
        label={label}
        name={name}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        onValueChange={(next) => {
          setOwn(next);
          onValueChange?.(next);
        }}
      />
    </FieldFrame>
  );
}

const DRAFT = 'm-draft:';
const kept = (key: string | undefined): string => {
  try {
    return key ? (window.sessionStorage.getItem(DRAFT + key) ?? '') : '';
  } catch {
    return '';
  }
};
const keep = (key: string | undefined, text: string): void => {
  try {
    if (!key) return;
    if (text) window.sessionStorage.setItem(DRAFT + key, text);
    else window.sessionStorage.removeItem(DRAFT + key);
  } catch {
    // A browser that keeps nothing still sends what is written.
  }
};

export type ComposerProps = {
  /* What is being written: `Add a note`. */
  label: string;
  placeholder?: string;
  /* Asked to send the words. While it runs the button turns; if it throws, the words stay and the reason is said. */
  onSend: (words: string) => void | Promise<void>;
  /* A name to keep an unsent note under, so leaving the record and coming back finds it. */
  draftKey?: string;
  sendLabel?: string;
  /* What the box starts with, ahead of anything kept. */
  defaultValue?: string;
};

/* The box a note is sent from. Ctrl or Cmd with Enter sends. What was typed and not sent is kept for the visit
   under `draftKey`, so a reader called away to another record finds their half a note where they left it. The
   words are cleared only once they have gone: a send that fails leaves them in the box. */
export function Composer({ label, placeholder, onSend, draftKey, sendLabel, defaultValue }: ComposerProps) {
  const [text, setText] = useState(() => defaultValue ?? kept(draftKey));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const write = (next: string) => {
    setText(next);
    setProblem(null);
    keep(draftKey, next);
  };
  const send = async () => {
    const said = text.trim();
    if (!said || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await onSend(said);
      write('');
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : words.notSent);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      data-slot="composer"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <NoteArea
        label={label}
        value={text}
        placeholder={placeholder ?? label}
        onValueChange={write}
        onSubmit={() => void send()}
        rows={2}
        end={
          <span data-slot="composer-end">
            <span data-slot="composer-hint" aria-hidden="true">
              <kbd data-slot="kbd">{MOD}</kbd>
              <kbd data-slot="kbd">Enter</kbd>
            </span>
            <Button type="submit" intent="primary" size="sm" busy={busy} disabled={!text.trim()}>
              <PaperPlaneTilt aria-hidden="true" weight="fill" />
              {sendLabel ?? words.send}
            </Button>
          </span>
        }
      />
      {problem && (
        <p data-slot="composer-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

export type TimelineEntry = {
  id: string;
  /* A note has an author and words; an event is one line the record wrote about itself. */
  kind?: 'note' | 'event';
  author?: string;
  /* When, as an ISO date and time. */
  at: string;
  /* An event's line. */
  title?: string;
  /* A note's words (./prose.tsx). */
  body?: string;
  reactions?: { key: string; count: number; mine?: boolean }[];
};

export type RecordTimelineProps = {
  label: string;
  entries: TimelineEntry[];
  /* Asked to add a note. Without it the timeline is only read. */
  onSend?: (words: string) => Promise<void> | void;
  /* Asked when a reaction is pressed, on or off. */
  onReact?: (entry: TimelineEntry, key: string) => void;
  /* The reactions offered. */
  reactions?: string[];
  /* Who is writing, for a note shown before the caller has it. */
  me?: string;
  draftKey?: string;
  placeholder?: string;
  /* The moment that is now: a page that knows it in the App's zone, or a test. */
  now?: Date;
  /* The level of a day's heading: one under whatever the timeline stands under. */
  headingLevel?: 2 | 3 | 4;
};

type Pending = { id: string; words: string; at: string; failed?: string };

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function dayWords(day: Date, now: Date): string {
  if (sameDay(day, now)) return words.today;
  const before = new Date(now);
  before.setDate(now.getDate() - 1);
  if (sameDay(day, before)) return words.yesterday;
  return day.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: day.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/* When, the way it would be said: how long ago for the last few hours, the time of day after that (the day is the
   heading it stands under). */
function whenWords(at: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes >= 0 && minutes < 1) return words.justNow;
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'always', style: 'short' });
  if (minutes >= 0 && minutes < 60) return relative.format(-minutes, 'minute');
  if (minutes >= 0 && minutes < 360) return relative.format(-Math.round(minutes / 60), 'hour');
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/* What happened on a record and what was said about it, oldest first under the day it happened, with the box to
   add to it at its end, where the newest is. A note is shown the moment it is sent, marked as on its way; if it
   does not arrive it stays, says so, and can be sent again or taken back into the box, so nothing typed is lost
   to a bad connection. */
export function RecordTimeline({
  label,
  entries,
  onSend,
  onReact,
  reactions = ['👍', '✅', '👀', '❤️'],
  me,
  draftKey,
  placeholder,
  now = new Date(),
  headingLevel = 2,
}: RecordTimelineProps) {
  const Day = `h${headingLevel}` as 'h2';
  const [pending, setPending] = useState<Pending[]>([]);
  const [taken, setTaken] = useState<{ words: string; turn: number } | null>(null);
  const count = useRef(0);

  // A note the caller now has is no longer on its way.
  useEffect(() => {
    setPending((list) => {
      const left = list.filter(
        (one) => one.failed || !entries.some((entry) => entry.kind !== 'event' && entry.body === one.words && entry.at >= one.at),
      );
      return left.length === list.length ? list : left;
    });
  }, [entries]);

  const deliver = async (one: Pending) => {
    setPending((list) => list.map((other) => (other.id === one.id ? { ...other, failed: undefined } : other)));
    try {
      await onSend?.(one.words);
      setPending((list) => list.filter((other) => other.id !== one.id));
    } catch (error) {
      const why = error instanceof Error && error.message ? error.message : words.notSent;
      setPending((list) => list.map((other) => (other.id === one.id ? { ...other, failed: why } : other)));
      announce(why);
    }
  };
  const send = (said: string) => {
    count.current += 1;
    const one = { id: `~pending-${count.current}`, words: said, at: new Date().toISOString() };
    setPending((list) => [...list, one]);
    void deliver(one);
  };

  const days = useMemo(() => {
    const ordered = [...entries].sort((a, b) => a.at.localeCompare(b.at));
    const out: { day: Date; entries: TimelineEntry[] }[] = [];
    for (const entry of ordered) {
      const at = new Date(entry.at);
      const last = out[out.length - 1];
      if (last && sameDay(last.day, at)) last.entries.push(entry);
      else out.push({ day: at, entries: [entry] });
    }
    return out;
  }, [entries]);

  return (
    <section data-slot="record-timeline" aria-label={label}>
      {days.length === 0 && pending.length === 0 && <p data-slot="timeline-empty">{words.nothingYet}</p>}
      {days.map((group) => (
        <div key={group.day.toDateString()} data-slot="timeline-day">
          <Day>{dayWords(group.day, now)}</Day>
          <ol>
            {group.entries.map((entry) => {
              const at = new Date(entry.at);
              const time = (
                <time dateTime={entry.at} title={at.toLocaleString()}>
                  {whenWords(at, now)}
                </time>
              );
              if (entry.kind === 'event') {
                return (
                  <li key={entry.id} data-slot="timeline-event">
                    <span data-slot="timeline-dot" aria-hidden="true" />
                    <span>{entry.title}</span>
                    {time}
                  </li>
                );
              }
              const offered = reactions.filter((key) => !entry.reactions?.some((one) => one.key === key));
              return (
                <li key={entry.id} data-slot="timeline-note">
                  <Avatar name={entry.author ?? '?'} size="sm" />
                  <article>
                    <header>
                      <b>{entry.author}</b>
                      {time}
                    </header>
                    {entry.body && <Prose>{entry.body}</Prose>}
                    {onReact && (
                      <div data-slot="timeline-reactions">
                        {entry.reactions?.map((one) => (
                          <button
                            key={one.key}
                            type="button"
                            aria-pressed={Boolean(one.mine)}
                            aria-label={words.reaction(one.key, one.count)}
                            onClick={() => onReact(entry, one.key)}
                          >
                            <span aria-hidden="true">{one.key}</span>
                            <span aria-hidden="true">{one.count}</span>
                          </button>
                        ))}
                        {offered.length > 0 && (
                          <DropMenu
                            label={words.react}
                            quiet
                            align="start"
                            trigger={<Smiley aria-hidden="true" />}
                            items={offered.map((key) => ({ value: key, label: key }))}
                            onAction={(key) => onReact(entry, key)}
                          />
                        )}
                      </div>
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      {pending.length > 0 && (
        <ol data-slot="timeline-pending">
          {pending.map((one) => (
            <li key={one.id} data-slot="timeline-note" data-pending={one.failed ? undefined : ''} data-failed={one.failed ? '' : undefined}>
              <Avatar name={me ?? '?'} size="sm" />
              <article>
                <header>
                  <b>{me}</b>
                  <span data-slot="timeline-state">{one.failed ?? words.sending}</span>
                </header>
                <Prose>{one.words}</Prose>
                {one.failed && (
                  <div data-slot="timeline-retry">
                    <Button size="sm" onClick={() => void deliver(one)}>
                      <ArrowClockwise aria-hidden="true" />
                      {words.sendAgain}
                    </Button>
                    <Button
                      size="sm"
                      intent="quiet"
                      onClick={() => {
                        setPending((list) => list.filter((other) => other.id !== one.id));
                        setTaken((before) => ({ words: one.words, turn: (before?.turn ?? 0) + 1 }));
                      }}
                    >
                      {words.editIt}
                    </Button>
                  </div>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
      {/* What it sends is shown at once above it, so the box is cleared as it sends; a note taken back from a send
          that failed starts a new box with its words. */}
      {onSend && (
        <Composer
          key={taken?.turn ?? 0}
          label={words.addNote}
          placeholder={placeholder}
          draftKey={draftKey}
          defaultValue={taken?.words}
          onSend={send}
        />
      )}
    </section>
  );
}
