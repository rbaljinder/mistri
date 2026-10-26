/**
 * The landing's sections that read the App's rows — a list view's cards,
 * and a search over its own filters — and its calls to action that open a
 * view, drawn inside the App for a visitor the public grant lets read them.
 * LandingSurface stays a page of the author's text; the App hands it these.
 *
 * A search writes exactly what the list's filter boxes would: a choice is
 * `= value`, typed text is `contains`, a most-you-would-pay is `<=`, each
 * through the same condition writer, into the list's own address. The
 * result is the list, and a link to it is the search.
 */
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { activeApp } from '../appState.js';
import { api, columnDisplay, columnLabel, findTable, go, quote, state, tableView } from '@mistriwork/kit/client/core.js';
import { equalsTail, withCondition } from '@mistriwork/kit/client/filterbar.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { formatMoney } from '@mistriwork/kit/client/locale.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { columnKind, primaryKey, type ColumnMeta, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { type LandingImage, type LandingSection } from '../../shared/appModel.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { listPresentationColumns } from '@mistriwork/engine/shared/appListColumns.js';
import { appListQuery, specTabs, visibleQuestion, wholeQuery, type ListSpec } from '@mistriwork/kit/client/components/appListModel.js';
import { isListRoom, viewRoom } from '@mistriwork/kit/client/components/appRooms.js';
import { viewLink } from '@mistriwork/kit/client/components/viewLink.js';
import { choiceWord, dressFor, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { inlineFileAddress } from '@mistriwork/kit/client/components/cardsModel.js';
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import { onDemand, useArrived } from '@mistriwork/kit/client/components/onDemand.js';
import { SuggestBox } from '@mistriwork/kit/client/components/suggestPart.js';
import { say } from '../copy/public/components/LandingData.js';

const CardsList = onDemand(() => import('@mistriwork/kit/client/components/CardsList.js'), 'CardsList');

type Section<K extends LandingSection['kind']> = Extract<LandingSection, { kind: K }>;
type Row = Record<string, unknown>;

/** A text column with this many values or fewer is offered as a choice; past it, typed. */
const CHOICES = 24;

function listRoom(key: string): ListSpec | undefined {
  const app = activeApp() as Parameters<typeof viewRoom>[0] | null;
  const room = app ? viewRoom(app, key) : undefined;
  return room && isListRoom(room) ? room : undefined;
}

const connection = () => state.activeConnection ?? null;
const owned = () => (connection() ? ownedBy(connection()) : {});

/** A list view's rows as its cards, the first `limit` by `sort`: the list's own question, narrowed. */
export function LandingCards({ section }: { section: Section<'view'> }) {
  const spec = listRoom(section.view);
  const table = spec ? (findTable(spec.table) as TableMeta | undefined) : undefined;
  const cards = spec?.presentation?.kind === 'cards' ? spec.presentation : undefined;
  const text =
    spec && table && cards
      ? [
          spec.table,
          andQuery(spec.query, specTabs(spec)[0]?.query),
          section.sort ? `sort ${section.sort}` : '',
          `show ${[...new Set([...(spec.show ?? []), ...listPresentationColumns(cards), ...primaryKey(table)])].join(', ')}`,
        ]
          .filter(Boolean)
          .join(' ')
      : '';
  const limit = section.limit ?? 6;
  const answer = useQuery({
    queryKey: ['run', connection() ?? '', 'landing-cards', text, limit],
    enabled: Boolean(text),
    queryFn: async () => {
      const data = (await api('/api/run', { q: text, limit, offset: 0, count: 'none', ...owned() })) as {
        rows?: Row[];
        errors?: Array<{ message: string }>;
      };
      if (data.errors?.length) throw new Error(data.errors[0].message);
      return data.rows ?? [];
    },
  });
  /* The cards come with the rows: asked for beside them, and the section stays empty until both are here. */
  const cardsHere = useArrived(CardsList, Boolean(cards));
  if (!spec || !table || !cards) return null;
  if (answer.isError) return <p className="front-note">{(answer.error as Error).message}</p>;
  if (!answer.data || !cardsHere) return null;
  if (!answer.data.length) return <p className="front-note">{say('nothingToShowHere')}</p>;
  const more = viewLink(section.view);
  return (
    <>
      <CardsList table={table} rows={answer.data} spec={cards} label={section.title ?? spec.label} />
      {more && (
        <p className="front-more">
          <a href={more.href} onClick={more.onClick}>
            {say('seeAll', { things: (spec.label ?? '').toLocaleLowerCase() })}
          </a>
        </p>
      )}
    </>
  );
}

/** Round figures up to the highest value, for a most-you-would-pay: 1, 1.5, 2, 2.5, 3, 4, 5, 7.5 of each power of ten. */
export function priceSteps(max: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  const steps: number[] = [];
  for (let power = 10 ** Math.max(0, Math.floor(Math.log10(max)) - 1); steps.length < 40; power *= 10) {
    for (const lead of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5]) {
      const step = lead * power;
      if (step >= max / 12) steps.push(step);
      if (step >= max) return steps;
    }
  }
  return steps;
}

type Field = {
  name: string;
  label: string;
  column: ColumnMeta;
  kind: 'choice' | 'text' | 'max';
  options?: Array<{ value: string; label: string }>;
};

/** How a field is asked: a vocabulary or a short list of values is a choice; a number, a ceiling; other text, typed. */
function useFields(table: TableMeta | undefined, spec: ListSpec | undefined, names: readonly string[]): Field[] | undefined {
  const where = spec ? andQuery(spec.query, specTabs(spec)[0]?.query) : '';
  const columns = names
    .map((name) => table?.columns.find((column) => column.name === name))
    .filter((column): column is ColumnMeta => Boolean(column));
  const answer = useQuery({
    queryKey: ['breakdown', 'landing-search', table?.id, where, names],
    enabled: Boolean(table && spec),
    queryFn: () =>
      Promise.all(
        columns.map(async (column): Promise<Field> => {
          const label = (columnLabel(table!.id, column.name) as string | null) ?? humanName(column.name);
          const allowed = (column as ColumnMeta & { allowed?: string[] }).allowed;
          if (allowed?.length)
            return {
              name: column.name,
              label,
              column,
              kind: 'choice',
              options: allowed.map((value) => ({
                value,
                label: choiceWord(columnDisplay(table!.id, column.name) as DisplayRule | null, value),
              })),
            };
          if (columnKind(column.type) === 'number') {
            const data = (await api('/api/breakdown', {
              text: [table!.id, where, `max ${column.name}`].filter(Boolean).join(' '),
              limit: 1,
              ...owned(),
            })) as { rows?: Row[] };
            const top = Number(Object.values(data.rows?.[0] ?? {})[0]);
            const rule = columnDisplay(table!.id, column.name) as DisplayRule | null;
            return {
              name: column.name,
              label: say('maxLabel', { label: label.toLocaleLowerCase() }),
              column,
              kind: 'max',
              options: priceSteps(top).map((step) => ({
                value: String(step),
                label:
                  rule?.format === 'money'
                    ? formatMoney(step, rule.currency, { maximumFractionDigits: 0 })
                    : (dressFor(rule, step)?.text ?? step.toLocaleString()),
              })),
            };
          }
          const data = (await api('/api/breakdown', {
            text: [table!.id, where, `count by ${column.name}`].filter(Boolean).join(' '),
            limit: CHOICES + 1,
            ...owned(),
          })) as { rows?: Row[]; columns?: string[] };
          const values = (data.rows ?? [])
            .map((row) => row[data.columns?.[0] ?? column.name])
            .filter((value) => value !== null && value !== undefined && value !== '')
            .map(String);
          return values.length && values.length <= CHOICES
            ? {
                name: column.name,
                label,
                column,
                kind: 'choice',
                options: [...values].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value })),
              }
            : { name: column.name, label, column, kind: 'text' };
        }),
      ),
  });
  return answer.data;
}

/** A search over a list view: its own filters up front, submitted as the list's conditions. */
export function LandingSearch({ section }: { section: Section<'search'> }) {
  const spec = listRoom(section.view);
  const table = spec ? (findTable(spec.table) as TableMeta | undefined) : undefined;
  const fields = useFields(table, spec, section.filters);
  const [values, setValues] = useState<Record<string, string>>({});
  /* A text field the list suggests for suggests here too: the hero is the list's search, asked early. */
  const suggesting = useArrived(SuggestBox, Boolean(spec?.suggest));
  if (!spec || !table || !fields) return null;
  const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    let text = visibleQuestion(spec, appListQuery(spec, 0));
    for (const field of fields) {
      const value = (values[field.name] ?? '').trim();
      if (!value) continue;
      const tail = field.kind === 'text' ? `contains ${quote(value)}` : field.kind === 'max' ? `<= ${value}` : equalsTail(value);
      text = withCondition(text, field.name, tail) as string;
    }
    (state as { page: number }).page = 0;
    go({ ...tableView(spec.table, wholeQuery(spec, text)), view: section.view }, 'push');
  };
  return (
    <form
      className="front-search-form"
      role="search"
      aria-label={section.title ?? say('search', { label: spec.label ?? '' }).trim()}
      onSubmit={submit}
    >
      <div className="front-search-fields">
        {fields.map((field) => (
          <label key={field.name} className="front-search-field">
            <span className="front-search-label">{field.label}</span>
            {field.kind === 'text' && suggesting && spec.suggest?.[field.name] ? (
              /* A pick fills the field; the form's own button searches, with whatever else the hero asks. */
              <SuggestBox
                table={table.id}
                columns={spec.suggest[field.name]}
                standing={spec.query ?? ''}
                text={values[field.name] ?? ''}
                onText={(value) => set(field.name, value)}
                onPick={(value) => set(field.name, value)}
                inputProps={{ type: 'search', className: 'front-search-input', placeholder: say('common.any') }}
              />
            ) : field.kind === 'text' ? (
              <input
                type="search"
                className="front-search-input"
                placeholder={say('common.any')}
                value={values[field.name] ?? ''}
                onChange={(event) => set(field.name, event.target.value)}
              />
            ) : (
              <Dropdown
                ariaLabel={field.label}
                value={values[field.name] ?? ''}
                onChange={(value) => set(field.name, value)}
                items={[{ value: '', label: field.kind === 'max' ? say('noLimit') : say('common.any') }, ...(field.options ?? [])]}
              />
            )}
          </label>
        ))}
      </div>
      <button type="submit" className="front-action front-action-primary front-search-go">
        {section.submitLabel ?? say('navigation.search')}
      </button>
    </form>
  );
}

/** The hero's photo: its row of the App's files, by key, drawn inline through the file route. */
export function landingImage(image: LandingImage): string | undefined {
  const table = findTable(image.from) as TableMeta | undefined;
  const key = table ? primaryKey(table) : [];
  return table && key.length === 1 ? inlineFileAddress(table.id, { [key[0]]: image.key }, state.activeConnection ?? null) : undefined;
}

/** The two sections the App draws for the landing; anything else is the landing's own. */
export function landingSection(section: LandingSection) {
  if (section.kind === 'view') return <LandingCards section={section} />;
  if (section.kind === 'search') return <LandingSearch section={section} />;
  return null;
}
