/**
 * A command's reference input as a picker over its resource: a part loaded on
 * demand (CommandFields draws it through `onDemand`), so a public form's first
 * page carries neither this nor the combobox it is drawn with. A signed-in
 * reader reads its choices through their connection; a public form's visitor
 * through the App's signed-out read, which answers only what `auth.public`
 * opens (server forms/savedFormChecks.ts, [public-form-picker]).
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, columnDisplay, state } from '@mistriwork/kit/client/core.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import type { CommandValue } from '../commandState.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';
import { Button } from '@mistriwork/ui/Button.js';
import { offeredChoices } from '@mistriwork/kit/client/components/pickerStaleness.js';
import { readsAsName } from '@mistriwork/kit/client/components/Dropdown.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { say as sayField } from '../copy/forms/components/CommandFields.js';
import { say } from '../copy/forms/components/CommandReference.js';
import { andQuery, splitClauseTail } from '@mistriwork/engine/shared/query.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { collidingNames, referenceSubline, sublineText, type Subline } from '@mistriwork/engine/shared/referenceSubline.js';
import { knownReferenceName, rememberReferenceName } from './referenceNames.js';
import { answered, sayInput } from './reviewValues.js';
import type { ReviewSource } from './ReviewValue.js';
import type { AppCommandField } from '../../shared/command.js';
/* The type only: a runtime import back into CommandFields, which loads this file on demand, would be a file loop. */
import type { ReferenceField } from './CommandFields.js';

/* A reference over a hierarchy: a part of its own, so a flat picker carries none of it. */
const TreePicker = onDemand(() => import('@mistriwork/kit/client/components/TreePicker.js'), 'TreePicker', { quiet: true });

/** Where a picker reads: a signed-in reader's connection, or a public form's App, read as its signed-out visitor. */
export type ChoiceSource = string | { visitor: { app: string; via?: string } };

/* A visitor's read is a plain fetch, as the form's submit is: no session plumbing, the App and its intake address in the URL. */
export async function run(
  source: ChoiceSource,
  body: { q: string; limit: number; offset: number; count: 'none' },
): Promise<{ rows?: unknown; errors?: unknown[] }> {
  return read(source, '/api/run', body);
}

/* A read through the same door: a tree picker's rows, and the breakdown that says which of them have children. */
async function read(
  source: ChoiceSource,
  path: '/api/run' | '/api/breakdown',
  body: Record<string, unknown>,
): Promise<{ rows?: unknown; errors?: unknown[] }> {
  if (typeof source === 'string') return api(path, { ...ownedBy(source), ...body } as Parameters<typeof api>[1]);
  const { app, via } = source.visitor;
  const query = new URLSearchParams({ app, ...(via ? { via } : {}) });
  const res = await fetchServer(`${path}?${query}`, {
    method: 'POST',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(say('choicesCouldNotBeLoaded'));
  return res.json();
}

/** What a reference's record is called, as the reader may read it: its label, and the second line that tells two of
    one name apart where the App's display shape gives one. */
export interface ReferenceName {
  label: string;
  detail?: string;
}

/**
 * What tells two records of one name apart (referenceSubline.ts, the rule every reference shares): the `subtitle` the
 * App's display gives the reference's label column on its resource (`display: { name: { subtitle: 'last4' } }`), else a
 * code, an email, the parent by name, the day it was made — when this reader's schema holds it. A visitor's read is the
 * key and the label alone, the columns a public form's picker is checked for (server forms/savedFormChecks.ts,
 * [public-form-picker]).
 */
function referenceDetail(field: ReferenceField, source: ChoiceSource): Subline | undefined {
  if (typeof source !== 'string' || !state.schema) return undefined;
  const schema = state.schema as DatabaseSchema;
  const table = tableNamed(schema, field.from);
  if (!table) return undefined;
  const display = { [field.labelColumn]: columnDisplay(table.id, field.labelColumn) as { subtitle?: unknown } | null };
  const sub = referenceSubline(schema, table, field.labelColumn, display);
  return sub && sub.path !== field.by ? sub : undefined;
}

const shown = (field: ReferenceField, detail: Subline | undefined) =>
  `show ${[...new Set([field.by, field.labelColumn, ...(detail ? [detail.path] : [])])].join(', ')}`;
const said = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : String(value));

/**
 * The name of the record a reference holds, read by its key the way its picker reads its choices: the same resource,
 * through the same door (the reader's connection, or the visitor's signed-out read), under the field's own filter, so
 * a key the picker would not offer — a row this reader can no longer read, or one the filter leaves out — has no name
 * (null). Never a name the page was handed: the key is what is sent, and what the server judges.
 */
export async function readReferenceName(
  field: ReferenceField,
  value: string | number,
  source: ChoiceSource,
): Promise<ReferenceName | null> {
  /* Read back alone, with nothing beside it to collide with: only the line the App asked for. */
  const declared = referenceDetail(field, source);
  const detail = declared?.declared ? declared : undefined;
  const key = `${field.by} = ${typeof value === 'number' ? value : JSON.stringify(value)}`;
  const q = [field.from, andQuery(splitClauseTail(field.query ?? '').head, key), shown(field, detail)].join(' ');
  const data = await run(source, { q, limit: 1, offset: 0, count: 'none' });
  if (data.errors?.length || !Array.isArray(data.rows)) throw new Error(say('choicesCouldNotBeLoaded'));
  const row = data.rows[0] as Record<string, unknown> | undefined;
  const label = said(row?.[field.labelColumn]);
  if (!row || label === undefined) return null;
  const second = detail ? sublineText(row[detail.path]) : undefined;
  return { label, ...(second ? { detail: second } : {}) };
}

/**
 * A reference's answer where a form reads its answers back (a review): its record's name, read again as it is drawn,
 * so a choice made before a permission changed is not named from what the page remembers. Until the name is read the
 * answer says so; a name that cannot be read, or a record no longer offered, is said as that — never as its key.
 */
export function ReferenceName({
  field,
  value,
  source,
  identityEpoch,
}: {
  field: ReferenceField;
  value: string | number;
  source: ChoiceSource;
  identityEpoch: number;
}) {
  const name = useQuery({
    queryKey: ['reference-review-name', identityEpoch, source, field.from, field.by, field.labelColumn, field.query ?? '', value],
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: () => readReferenceName(field, value, source),
  });
  if (name.isPending) return <span aria-busy="true">{say('loadingName')}</span>;
  if (name.isError)
    return (
      <span>
        {say('nameCouldNotBeLoaded')}{' '}
        <Button intent="quiet" size="compact" onClick={() => void name.refetch()}>
          {say('tryAgain')}
        </Button>
      </span>
    );
  if (!name.data) return <span>{say('noLongerAvailable')}</span>;
  return (
    <>
      {name.data.label}
      {name.data.detail && <span className="review-detail"> · {name.data.detail}</span>}
    </>
  );
}

/** One member's answer on a review, a reference by its record's name. */
function Said({ field, value, from }: { field: AppCommandField; value: unknown; from: ReviewSource }) {
  if (field.type === 'reference' && (typeof value === 'string' || typeof value === 'number') && value !== '')
    return <ReferenceName field={field} value={value} source={from.source} identityEpoch={from.identityEpoch} />;
  return <>{sayInput(field, value)}</>;
}

/**
 * A review's answer that holds a reference (ReviewValue.tsx): the reference, or a group with reference members, said
 * as reviewLines says a group — a line per member, or per row of a repeating group — each reference by its name.
 * Here, with the picker, so a form's first page carries none of it.
 */
export function ReviewNamed({ field, value, from }: { field: AppCommandField; value: unknown; from: ReviewSource }) {
  if (field.type !== 'group') return <Said field={field} value={value} from={from} />;
  type Part = { member: AppCommandField; held: unknown };
  const partsOf = (row: unknown): Part[] =>
    field.fields
      .map((member) => ({ member, held: (row as Record<string, unknown> | undefined)?.[member.name] }))
      .filter(({ held }) => answered(held));
  const lines: Part[][] = field.repeat
    ? (Array.isArray(value) ? value : []).map(partsOf).filter((parts) => parts.length)
    : partsOf(value).map((part) => [part]);
  if (!lines.length) return <>—</>;
  const line = (parts: Part[]) =>
    parts.map(({ member, held }, index) => (
      <Fragment key={member.name}>
        {index > 0 && ', '}
        {field.fields.length > 1 && `${member.label}: `}
        <Said field={member} value={held} from={from} />
      </Fragment>
    ));
  if (lines.length === 1) return <>{line(lines[0])}</>;
  return (
    <ul className="review-lines">
      {lines.map((parts, index) => (
        <li key={index}>{line(parts)}</li>
      ))}
    </ul>
  );
}

type ReferenceFieldProps = Parameters<typeof FlatReferenceField>[0];

/** A reference input as a picker over its resource: the command modal's, and a signed-in command form's — drawn as
    its hierarchy where the field names one (`tree`), else a flat list of what matches. */
export function CommandReferenceField(props: ReferenceFieldProps) {
  return props.field.tree ? <TreeReferenceField {...props} /> : <FlatReferenceField {...props} />;
}

/* The same field over a hierarchy (TreePicker.tsx, a part of its own): read through the same door, under the same
   filter, and the name it picks remembered as the flat picker's is, so a review says it at once. */
function TreeReferenceField({
  field,
  id,
  describedBy,
  invalid,
  connection,
  identityEpoch,
  value,
  disabled,
  onChange,
  isCurrent,
}: ReferenceFieldProps) {
  const held = typeof value === 'string' || typeof value === 'number' ? value : '';
  return (
    <TreePicker
      from={field.from}
      by={field.by}
      labelColumn={field.labelColumn}
      parent={field.tree!}
      where={splitClauseTail(field.query ?? '').head || undefined}
      ask={(path, body) => read(connection, path, body)}
      scope={JSON.stringify([identityEpoch, connection])}
      value={held}
      known={held === '' ? undefined : knownReferenceName(field, connection, identityEpoch, held)}
      onChange={(next, label) => {
        if (!isCurrent()) return;
        if (next !== '' && label !== undefined) rememberReferenceName(field, connection, identityEpoch, next, label);
        onChange(next);
      }}
      id={id}
      listLabel={field.label}
      describedBy={describedBy}
      invalid={invalid}
      required={field.required}
      disabled={disabled}
      placeholder={readsAsName(field.label) ? sayField('choosePlaceholder', { label: field.label.toLowerCase() }) : sayField('chooseOne')}
    />
  );
}

function FlatReferenceField({
  field,
  id,
  describedBy,
  invalid,
  connection,
  identityEpoch,
  value,
  disabled,
  onChange,
  isCurrent,
}: {
  field: ReferenceField;
  id: string;
  describedBy?: string;
  invalid?: boolean;
  connection: ChoiceSource;
  identityEpoch: number;
  value?: CommandValue;
  disabled: boolean;
  onChange: (value: string | number) => void;
  isCurrent: () => boolean;
}) {
  /* The box says the record's name: one this picker read for the same key before (its step drawn again, Back from the
     review) at once, else the key until the name below is read. */
  const nameOf = (held: CommandValue | undefined) =>
    typeof held === 'string' || typeof held === 'number' ? knownReferenceName(field, connection, identityEpoch, held) : undefined;
  const [text, setText] = useState(value === undefined ? '' : (nameOf(value) ?? String(value)));
  /* The value the box's words stand for, and the last one it handed up itself. A value that changes from outside —
     the command's starting values, which prepare answers after the picker is drawn — is said afresh: seeded once, at
     mount, the box kept its placeholder over a chosen chair. */
  const [seeded, setSeeded] = useState(value);
  const own = useRef(value);
  if (value !== seeded) {
    setSeeded(value);
    if (value !== own.current) setText(value === undefined || value === '' ? '' : (nameOf(value) ?? String(value)));
    own.current = value;
  }
  const [asked, setAsked] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setAsked(text.trim()), 150);
    return () => clearTimeout(timer);
  }, [text]);
  /* A value the form started with is a key; the box says the record's name, as it does once one is picked. */
  const held = typeof value === 'string' || typeof value === 'number' ? value : undefined;
  const named = useQuery({
    queryKey: ['command-choice-label', identityEpoch, connection, field.from, field.by, field.labelColumn, field.query ?? '', held],
    retry: false,
    enabled: held !== undefined && held !== '' && isCurrent(),
    queryFn: async () => {
      const read = await readReferenceName(field, held!, connection);
      if (read) rememberReferenceName(field, connection, identityEpoch, held!, read.label);
      return read?.label ?? null;
    },
  });
  useEffect(() => {
    if (named.data && held !== undefined && text === String(held)) setText(named.data);
  }, [named.data, held, text]);
  const choices = useQuery({
    queryKey: ['command-choices', identityEpoch, connection, field, asked],
    retry: false,
    enabled: open && !disabled && isCurrent(),
    queryFn: async () => {
      if (!isCurrent()) throw new Error(sayField('common.thisCommandFormIsNoLonger'));
      const result = await commandChoices(field, asked, connection);
      if (!isCurrent()) throw new Error(sayField('common.thisCommandFormIsNoLonger'));
      return result;
    },
  });
  /* For the pause before the typed search is asked, the list answers earlier
     text with its first row lit: offer only the rows the box's text names, so
     Enter cannot put a reviewer nobody typed into the command. */
  const { choices: offered, answered } = offeredChoices({
    typed: text,
    asked,
    placeholder: choices.isPlaceholderData,
    rows: choices.data,
    label: (choice) => choice.label,
  });
  const twice = collidingNames(offered.map((choice) => choice.label));
  return (
    <div className="picker">
      <Typeahead
        text={text}
        onText={(next) => {
          setText(next);
          own.current = '';
          onChange('');
        }}
        open={open && !disabled}
        onOpenChange={setOpen}
        items={offered}
        itemKey={(choice) => `${typeof choice.value}:${choice.value}`}
        itemLabel={(choice) => choice.label}
        itemClassName={(_choice, highlighted) => `picker-option${highlighted ? ' active' : ''}`}
        renderItem={(choice) => (
          <>
            <span className="picker-option-label">{choice.label}</span>
            {/* Two records of one name are told apart by their second line; the App's own is drawn under every one. */}
            {choice.detail && (choice.declared || twice.has(choice.label)) && <span className="picker-option-detail">{choice.detail}</span>}
          </>
        )}
        onPick={(choice) => {
          if (isCurrent()) {
            rememberReferenceName(field, connection, identityEpoch, choice.value, choice.label);
            own.current = choice.value;
            onChange(choice.value);
            setText(choice.label);
            setOpen(false);
          }
        }}
        inputProps={{
          /* Named by the field's <label for> (components/Field.tsx), "(required)" and all, as a textbox is. */
          id,
          'aria-describedby': describedBy,
          'aria-invalid': invalid || undefined,
          required: field.required,
          disabled,
          className: 'picker-input',
          placeholder: readsAsName(field.label)
            ? sayField('choosePlaceholder', { label: field.label.toLowerCase() })
            : sayField('chooseOne'),
        }}
        fit="width"
        popupClassName="picker-popup"
        listClassName="picker-list"
        emptyClassName="picker-empty"
        empty={
          choices.isError
            ? say('choicesCouldNotBeLoaded')
            : choices.isFetching || !answered
              ? say('loadingChoices')
              : say('noMatchingChoices')
        }
      />
    </div>
  );
}

interface Choice {
  value: string | number;
  label: string;
  detail?: string;
  /** The App's display asked for the line: drawn under every choice, not only where two names collide. */
  declared?: boolean;
}
export async function commandChoices(field: ReferenceField, text: string, source: ChoiceSource): Promise<Choice[]> {
  // Authored filters constrain eligibility; this picker owns projection, ordering and page size.
  const condition = andQuery(splitClauseTail(field.query ?? '').head, text ? `${field.labelColumn} contains ${JSON.stringify(text)}` : '');
  const detail = referenceDetail(field, source);
  const q = [field.from, condition, shown(field, detail), `sort ${field.labelColumn}`].filter(Boolean).join(' ');
  const data = await run(source, { q, limit: 20, offset: 0, count: 'none' });
  if (data.errors?.length || !Array.isArray(data.rows)) throw new Error(say('choicesCouldNotBeLoaded'));
  return data.rows.slice(0, 20).flatMap((row: Record<string, unknown>) => {
    const value = row[field.by];
    return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
      ? [
          {
            value,
            label: String(row[field.labelColumn] ?? value),
            ...(detail && sublineText(row[detail.path]) ? { detail: sublineText(row[detail.path])!, declared: detail.declared } : {}),
          },
        ]
      : [];
  });
}
