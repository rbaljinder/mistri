/**
 * A timeline's composer (PageTimeline.tsx), pinned under its rows: the App
 * framework's, since it sends through the App's commands, and drawn on the
 * kit's record page through the shell's slot (slots.TimelineComposer).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, state, toast } from '@mistriwork/kit/client/core.js';
import type { AppCommandField } from '../../shared/app.js';
import { Button } from '@mistriwork/ui/Button.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { actionOf, commandHandle } from './sdk/commands.js';
import { holdComposer } from '@mistriwork/kit/client/components/composerDraft.js';
import type { PageSection } from '@mistriwork/kit/client/components/pageModel.js';
import { RichTextField, mentionSearch, pictureKeeper } from '@mistriwork/kit/client/components/RichTextField.js';
import { shellById } from '@mistriwork/kit/client/shellHost.js';
import { say } from '../copy/record/components/TimelineComposer.js';

/** A conversation's composer, pinned under its rows: a Reply / Internal note toggle over one box, sent through the
    commands the author named — the same pipeline a record's action button and `useCommand` use, so a refusal is said
    in the server's words and a command that asks for more than the text opens its own form, filled with it. */
export function TimelineComposer({
  composer,
  recordKey,
  table,
  onSent,
}: {
  composer: NonNullable<PageSection['composer']>;
  recordKey: Record<string, string | number>;
  /** The record's table: a rich text reply's pictures are kept as its attachments. */
  table?: string;
  onSent: () => void;
}) {
  const modes = (
    [
      ['reply', composer.reply, say('reply'), say('writeAReply')],
      ...(composer.note ? [['note', composer.note, say('internalNote'), say('writeAnInternalNote')] as const] : []),
    ] as const
  ).filter(([, ref]) => commandHandle(ref).granted);
  const [chosen, setChosen] = useState<string>(modes[0]?.[0] ?? 'reply');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const label = useId();
  const offered = modes.map(([id]) => id).join(' ');
  /* A custom section's useComposer().fill lands here: the words in the box, the mode chosen where it is offered,
     the caret in the box — and nothing sent. */
  useEffect(
    () =>
      offered
        ? holdComposer((words, wanted) => {
            if (wanted && offered.split(' ').includes(wanted)) setChosen(wanted);
            setText(words);
            requestAnimationFrame(() => (input.current ?? shellById(label))?.focus());
          })
        : undefined,
    [offered, label],
  );
  const mode = modes.find(([id]) => id === chosen) ?? modes[0];
  if (!mode) return null;
  const [, ref, , placeholder] = mode;
  /* The text is the command's rich text input where it has one, else its first text input; the form the command
     asks for is the command's own. */
  const fields: AppCommandField[] = actionOf(ref)?.command.input ?? [];
  const field = fields.find((f) => f.type === 'richText') ?? fields.find((f) => f.type === 'textarea' || f.type === 'text');
  const rich = field?.type === 'richText' ? field : undefined;
  const send = async () => {
    const words = text.trim();
    if (!words || sending) return;
    setSending(true);
    try {
      const outcome = await commandHandle(ref).run(recordKey, { [field?.name ?? 'body']: words }, { label: mode[2] });
      if (outcome.status === 'applied') {
        setText('');
        onSent();
        input.current?.focus();
      }
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className={`timeline-composer${mode[0] === 'note' ? ' is-note' : ''}`}
      aria-label={say('conversation')}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {modes.length > 1 && (
        <div className="timeline-modes" role="group" aria-label={say('mode')}>
          {modes.map(([id, , caption]) => (
            <button key={id} type="button" className={`timeline-mode is-${id}`} aria-pressed={id === mode[0]} onClick={() => setChosen(id)}>
              {caption}
            </button>
          ))}
        </div>
      )}
      <label className="visually-hidden" htmlFor={label}>
        {mode[2]}
      </label>
      {rich ? (
        <RichTextField
          id={label}
          label={mode[2]}
          placeholder={placeholder}
          value={text}
          disabled={sending}
          onChange={setText}
          onKey={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              void send();
              return true;
            }
            return false;
          }}
          {...(rich.mentions ? { mentions: mentionSearch(rich.mentions, state.activeConnection) } : {})}
          {...(() => {
            const keep = pictureKeeper(rich.images, table ? { table, key: recordKey } : undefined, state.activeConnection);
            return keep ? { pictures: keep, onProblem: (message: string) => toast(message, 'error') } : {};
          })()}
        />
      ) : (
        <textarea
          id={label}
          ref={input}
          className="field-control timeline-input"
          rows={3}
          value={text}
          placeholder={placeholder}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
      )}
      <div className="timeline-composer-foot">
        {composer.templates && (
          <Templates
            templates={composer.templates}
            onPick={(words) => {
              setText(words);
              requestAnimationFrame(() => (input.current ?? shellById(label))?.focus());
            }}
          />
        )}
        <Button intent="primary" type="submit" disabled={!text.trim() || sending}>
          {sending ? say('sending') : mode[0] === 'note' ? say('addNote') : mode[2]}
        </Button>
      </div>
    </form>
  );
}

/** The composer's canned replies: the rows of a resource the reader may read, asked for when the menu first opens,
    each picked by its label and putting its text in the box — the way `useComposer().fill` does, sending nothing. */
function Templates({
  templates,
  onPick,
}: {
  templates: NonNullable<NonNullable<PageSection['composer']>['templates']>;
  onPick: (words: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = useQuery({
    queryKey: ['composer-templates', state.activeConnection, templates.from, templates.query ?? ''],
    enabled: open,
    staleTime: 60_000,
    queryFn: async () =>
      /* The author's query says which rows are offered (a retired response is readable, and not offered). */
      (
        (await api('/api/run', { q: [templates.from, templates.query].filter(Boolean).join(' '), limit: 200, count: 'none' })) as {
          rows: Array<Record<string, unknown>>;
        }
      ).rows,
  });
  const list = (rows.data ?? [])
    .filter((row) => typeof row[templates.text] === 'string' && row[templates.text])
    .sort((a, b) => String(a[templates.labelColumn] ?? '').localeCompare(String(b[templates.labelColumn] ?? '')));
  return (
    <DropMenu
      className="timeline-templates"
      triggerClassName="ghost"
      label={say('templates')}
      popupClassName="page-actions-popup"
      side="top"
      align="start"
      open={open}
      onOpenChange={setOpen}
    >
      {rows.isPending ? (
        <DropItem className="page-actions-item" disabled onClick={() => {}}>
          {say('loadingTemplates')}
        </DropItem>
      ) : rows.isError ? (
        <DropItem className="page-actions-item" disabled onClick={() => {}}>
          {say('templatesCouldNotBeRead')}
        </DropItem>
      ) : list.length ? (
        list.map((row, i) => (
          <DropItem key={i} className="page-actions-item" onClick={() => onPick(String(row[templates.text]))}>
            {String(row[templates.labelColumn] ?? row[templates.text])}
          </DropItem>
        ))
      ) : (
        <DropItem className="page-actions-item" disabled onClick={() => {}}>
          {say('noTemplates')}
        </DropItem>
      )}
    </DropMenu>
  );
}
