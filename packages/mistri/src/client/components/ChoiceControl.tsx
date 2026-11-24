/**
 * An App's `choose` in the bar: the row this person works in ("Site: Northside ▾"), and the dialog that changes it.
 *
 * The pick is the tab's (appChoices.ts) and the server's to believe: every request carries it, and the server reads
 * the row again under the reader, so this control only ever asks. Where the database keeps the person's picks it is
 * written there too, so their next device starts at the same site. It searches the choice's table as any reference's
 * picker does (RecordPicker.tsx), through the reader's own grants, so it offers only rows the server would accept.
 * A pick the reader can no longer read (a site taken away since) is forgotten when its label is looked up, and a
 * `required` choice then asks again before anything else. Below the width the bar holds it, the control leaves the
 * bar for the account menu (setChoiceEntry, AccountControl.tsx), which opens this same dialog.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';
import type { ServedChoice } from '@mistriwork/engine/shared/servedApp.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { api, findTable, labelPath, quote, state } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { activeApp } from '../appState.js';
import { choiceKey, choicesVersion, heldChoice, setChoiceEntry, subscribeChoices, writeChoice } from '../appChoices.js';
import { say } from '../copy/shell/components/ChoiceControl.js';
import './ChoiceControl.css';

/* As many rows as a reference's picker offers: past that, the reader narrows by typing. */
const LIMIT = 20;

interface Row {
  value: string;
  label: string;
}

/** The choice's rows matching `where`, each its key and the label the App names for it. */
async function rowsOf(table: TableMeta, naming: string, key: string, where: string, limit: number): Promise<Row[]> {
  const q = [table.id, where, `show ${[...new Set([naming, key])].join(', ')}`, `sort ${naming}`].filter(Boolean).join(' ');
  const data = await api('/api/run', { q, limit, offset: 0, count: 'none', ...ownedBy(state.activeConnection) });
  return ((data.rows ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row[key] !== null && row[key] !== undefined)
    .map((row) => ({ value: String(row[key]), label: String(row[naming] ?? row[key]) }));
}

interface ChoiceControlProps {
  /** The App's id, so one App's answers are never another's. */
  app: string;
  /** The choice's name in `choose` (`site`): what pages read as `chosen.site`. */
  name: string;
  choice: ServedChoice;
}

export function ChoiceControl({ app, name, choice }: ChoiceControlProps) {
  const owner = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  useSyncExternalStore(subscribeChoices, choicesVersion, choicesVersion);
  const client = useQueryClient();
  /* What the server holds for this person, where it keeps picks at all (the App's payload, `picks`). */
  const picks = activeApp()?.picks;
  const current = heldChoice(owner, name, picks);
  const table = findTable(choice.table) as TableMeta | undefined;
  const key = table ? primaryKey(table)[0] : undefined;
  const naming = (table && (choice.label ?? labelPath(table))) || key;
  const thing = humanName(name);
  const lower = thing.toLowerCase();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [listOpen, setListOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  const scope = [app, name, owner.epoch, owner.tenant?.tenantId ?? null];
  /* The picked row's label, read under the reader as every page will read the pick. */
  const picked = useQuery({
    queryKey: ['app-choice', ...scope, current],
    enabled: Boolean(table && key && naming && current !== null),
    queryFn: async () => (await rowsOf(table!, naming!, key!, `${key} = ${quote(current)}`, 1))[0] ?? null,
    staleTime: 60_000,
  });
  /* Read and not found: no longer this reader's to pick. Forgotten, so a required choice asks again. */
  const gone = picked.isSuccess && picked.data === null && current !== null;
  useEffect(() => {
    if (gone) writeChoice(owner, name, null, picks !== undefined);
  }, [gone, owner, name, picks]);

  const keepable = choiceKey(owner, name) !== null;
  const mustChoose = choice.required === true && keepable && Boolean(table) && (current === null || gone);
  const shown = open || mustChoose;
  const found = useQuery({
    queryKey: ['app-choice-search', ...scope, text],
    enabled: shown && Boolean(table && key && naming),
    queryFn: () => rowsOf(table!, naming!, key!, text ? `${naming} contains ${JSON.stringify(text)}` : '', LIMIT),
    placeholderData: keepPreviousData,
  });

  const label = current === null || gone ? undefined : picked.data?.label;
  const said = label ?? say('choose', { thing: lower });
  /* The list closes on a pick (Typeahead), and this control outlives its dialog: each opening starts with it open. */
  const openChooser = () => {
    setListOpen(true);
    setOpen(true);
  };
  const served = Boolean(table);
  useEffect(() => {
    if (!served) return;
    const entry = {
      choice: name,
      word: label === undefined ? '' : say('word', { thing }),
      name: said,
      picked: label,
      open: openChooser,
    };
    setChoiceEntry(entry);
    return () => setChoiceEntry(undefined, entry);
  }, [served, label, said, thing, name]);

  /* A pick changes what every page reads: each room asks again, with the new header. */
  const pick = (value: string | null) => {
    writeChoice(owner, name, value, picks !== undefined);
    /* The person's own store, for their next device: a refusal leaves the pick the tab's, which is all it was before. */
    if (picks !== undefined) void api('/api/choose', { name, value }).catch(() => undefined);
    setOpen(false);
    setText('');
    void client.invalidateQueries();
  };

  if (!table || !keepable) return null;
  return (
    <span className="tenant-control choice-control" data-choice={name}>
      <button
        type="button"
        className="ghost tenant-control-trigger choice-control-trigger"
        aria-haspopup="dialog"
        aria-expanded={shown}
        title={label}
        onClick={openChooser}
      >
        <span>
          {label === undefined ? (
            said
          ) : (
            <>
              <span className="choice-control-word">{say('word', { thing })} </span>
              <bdi>{label}</bdi>
            </>
          )}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {shown && (
        <Modal
          className="tenant-chooser-dialog choice-dialog"
          ariaLabel={say('choose', { thing: lower })}
          closeDisabled={mustChoose}
          initialFocus={input}
          onClose={() => {
            setOpen(false);
            setText('');
          }}
        >
          <section className="choice-chooser">
            <h2 className="choice-chooser-title">{say('choose', { thing: lower })}</h2>
            <p className="choice-chooser-lede">{mustChoose ? say('first', { thing: lower }) : say('change', { thing: lower })}</p>
            <Typeahead
              text={text}
              onText={(next) => {
                setText(next);
                setListOpen(true);
              }}
              open={listOpen}
              onOpenChange={setListOpen}
              items={found.data ?? []}
              itemKey={(row) => row.value}
              itemLabel={(row) => row.label}
              itemClassName={(_row, highlighted) => `picker-option choice-option${highlighted ? ' active' : ''}`}
              renderItem={(row) => (
                <>
                  <bdi className="picker-label">{row.label}</bdi>
                  {row.value === current && <span className="choice-option-current">{say('current')}</span>}
                </>
              )}
              onPick={(row) => pick(row.value)}
              ref={input}
              inputProps={{
                type: 'text',
                className: 'picker-input choice-input',
                placeholder: say('find', { thing: lower }),
                ariaLabel: say('find', { thing: lower }),
                autoComplete: 'off',
                spellCheck: false,
              }}
              fit="width"
              popupClassName="picker-popup choice-popup"
              listClassName="picker-list"
              empty={found.isError ? say('couldNotSearch') : found.isFetching ? undefined : say('noMatch', { thing: lower })}
              emptyClassName="picker-empty"
            />
          </section>
          {!mustChoose && (
            <div className="tenant-chooser-actions">
              {choice.required !== true && current !== null && (
                <button type="button" className="ghost choice-clear" onClick={() => pick(null)}>
                  {say('clear')}
                </button>
              )}
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setOpen(false);
                  setText('');
                }}
              >
                {say('common.close')}
              </button>
            </div>
          )}
        </Modal>
      )}
    </span>
  );
}
