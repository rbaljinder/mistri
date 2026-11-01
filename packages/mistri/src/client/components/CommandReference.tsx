/**
 * A command's reference input as a picker over its resource: a part loaded on
 * demand (CommandFields draws it through `onDemand`), so a public form's first
 * page carries neither this nor the combobox it is drawn with. A signed-in
 * reader reads its choices through their connection; a public form's visitor
 * through the App's signed-out read, which answers only what `auth.public`
 * opens (server forms/savedFormChecks.ts, [public-form-picker]).
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@mistriwork/kit/client/core.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import type { CommandValue } from '../commandState.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';
import { offeredChoices } from '@mistriwork/kit/client/components/pickerStaleness.js';
import { readsAsName } from '@mistriwork/kit/client/components/Dropdown.js';
import { say as sayField } from '../copy/forms/components/CommandFields.js';
import { say } from '../copy/forms/components/CommandReference.js';
import { andQuery, splitClauseTail } from '@mistriwork/engine/shared/query.js';
/* The type only: a runtime import back into CommandFields, which loads this file on demand, would be a file loop. */
import type { ReferenceField } from './CommandFields.js';

/** Where a picker reads: a signed-in reader's connection, or a public form's App, read as its signed-out visitor. */
export type ChoiceSource = string | { visitor: { app: string; via?: string } };

/* A visitor's read is a plain fetch, as the form's submit is: no session plumbing, the App and its intake address in the URL. */
export async function run(
  source: ChoiceSource,
  body: { q: string; limit: number; offset: number; count: 'none' },
): Promise<{ rows?: unknown; errors?: unknown[] }> {
  if (typeof source === 'string') return api('/api/run', { ...ownedBy(source), ...body });
  const { app, via } = source.visitor;
  const query = new URLSearchParams({ app, ...(via ? { via } : {}) });
  const res = await fetchServer(`/api/run?${query}`, {
    method: 'POST',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(say('choicesCouldNotBeLoaded'));
  return res.json();
}

/** The label of the record a reference already holds (a form opened with `prefill` or a default), or null when it is not readable. */
async function commandChoiceLabel(field: ReferenceField, value: string | number, source: ChoiceSource): Promise<string | null> {
  const q = `${field.from} ${field.by} = ${typeof value === 'number' ? value : JSON.stringify(value)} show ${[...new Set([field.by, field.labelColumn])].join(', ')}`;
  const data = await run(source, { q, limit: 1, offset: 0, count: 'none' });
  const label = Array.isArray(data.rows) ? (data.rows[0] as Record<string, unknown> | undefined)?.[field.labelColumn] : undefined;
  return label === undefined || label === null ? null : String(label);
}

/** A reference input as a picker over its resource: the command modal's, and a signed-in command form's. */
export function CommandReferenceField({
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
  const [text, setText] = useState(value === undefined ? '' : String(value));
  /* The value the box's words stand for, and the last one it handed up itself. A value that changes from outside —
     the command's starting values, which prepare answers after the picker is drawn — is said afresh: seeded once, at
     mount, the box kept its placeholder over a chosen chair. */
  const [seeded, setSeeded] = useState(value);
  const own = useRef(value);
  if (value !== seeded) {
    setSeeded(value);
    if (value !== own.current) setText(value === undefined || value === '' ? '' : String(value));
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
    queryKey: ['command-choice-label', identityEpoch, connection, field.from, field.by, field.labelColumn, held],
    retry: false,
    enabled: held !== undefined && held !== '' && isCurrent(),
    queryFn: () => commandChoiceLabel(field, held!, connection),
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
        renderItem={(choice) => <span className="picker-option-label">{choice.label}</span>}
        onPick={(choice) => {
          if (isCurrent()) {
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
}
export async function commandChoices(field: ReferenceField, text: string, source: ChoiceSource): Promise<Choice[]> {
  // Authored filters constrain eligibility; this picker owns projection, ordering and page size.
  const condition = andQuery(splitClauseTail(field.query ?? '').head, text ? `${field.labelColumn} contains ${JSON.stringify(text)}` : '');
  const q = [field.from, condition, `show ${[...new Set([field.by, field.labelColumn])].join(', ')}`, `sort ${field.labelColumn}`]
    .filter(Boolean)
    .join(' ');
  const data = await run(source, { q, limit: 20, offset: 0, count: 'none' });
  if (data.errors?.length || !Array.isArray(data.rows)) throw new Error(say('choicesCouldNotBeLoaded'));
  return data.rows.slice(0, 20).flatMap((row: Record<string, unknown>) => {
    const value = row[field.by];
    return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
      ? [{ value, label: String(row[field.labelColumn] ?? value) }]
      : [];
  });
}
