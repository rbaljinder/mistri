/**
 * The words an App list's surfaces say conditions in (conditionWords.ts),
 * and the speaker they say them through: the table's columns as this reader
 * is served them, their labels and display rules from the App, and the names
 * of the records the conditions point at, read through the same query a
 * reference box uses. Outside an App — the Workbench — there is no speaker,
 * and the language is said as written.
 *
 * The words are loaded on demand, the first time an App's list has a
 * condition to say: an unnarrowed list, the Workbench and every first page
 * go without them. Until they arrive a condition is said as written
 * (conditionText.ts), and each surface asking is drawn again when they do.
 */
import { useQueries } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { columnDisplay, columnLabel, findTable, state } from '../core.js';
import { hasFilterOf } from '@mistriwork/engine/shared/listFilters.js';
import { presentationColumns } from './columnPresentation.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { andWords, written } from './conditionText.js';
import type { ConditionSpeaker } from './conditionWords.js';
import { referenceNameQuery } from './FilterBoxes.js';
import { useMessageLanguage } from './useMessageLanguage.js';
import type { DisplayRule } from './valueModel.js';

/**
 * The App's words for a table's columns, before any record is named; null
 * outside an App. An App is where its words are registered (appnav's label
 * source, which answers every column); the Workbench registers none. Asked
 * of core rather than of appnav, so the grid that draws a column menu does
 * not pull the App's shell in with it.
 */
function appSpeaker(table: TableMeta | undefined): ConditionSpeaker | null {
  if (!table?.columns.length || columnLabel(table.id, table.columns[0].name) == null) return null;
  return {
    column: (name) => table.columns.find((column) => column.name === name) ?? acrossColumn(table, name),
    label: (name) => (columnLabel(table.id, name) as string | null) ?? humanName(name),
    rule: (name) => columnDisplay(table.id, name) as DisplayRule | null,
  };
}

/* A list filter across its related tables (shared/listFilters.ts) said as the column it asks: a path's column as
   it is served on the record it reaches, the column of the rows that point at the record, or — a segment of
   theirs — a yes with no value. A path or rows this reader is not served are no column, and said as another. */
function acrossColumn(table: TableMeta, name: string): (ColumnMeta & { allowed?: readonly string[] }) | undefined {
  const has = hasFilterOf(name);
  if (!has) return name.includes('.') ? (presentationColumns(state.schema, table, [name]).get(name) as ColumnMeta | undefined) : undefined;
  const child = (findTable(has.child) ?? state.schema?.tables.find((t: TableMeta) => t.name === has.child)) as TableMeta | undefined;
  if (!child) return undefined;
  if (child.segments && Object.hasOwn(child.segments, has.asks)) return { name, type: 'BOOLEAN', nullable: false, primaryKey: false };
  return presentationColumns(state.schema, child, [has.asks]).get(has.asks) as ColumnMeta | undefined;
}

type Words = typeof import('./conditionWords.js');
let words: Words | undefined;
let arriving: Promise<Words> | undefined;
const load = () => (arriving ??= import('./conditionWords.js').then((module) => (words = module)));

/** What a surface says conditions with: the App's words once loaded, else the language as written. */
interface ConditionWords {
  speaker: ConditionSpeaker | null;
  sayTails(speaker: ConditionSpeaker | null, column: string, tails: readonly string[]): string;
  sayCondition(speaker: ConditionSpeaker | null, condition: string): string;
  sayFilter(speaker: ConditionSpeaker | null, filter: string): string[];
  sayQuestion(speaker: ConditionSpeaker | null, text: string): string[];
  andWords(said: string[]): string;
}

const AS_WRITTEN: Omit<ConditionWords, 'speaker'> = {
  sayTails: (_, column, tails) => written.tails(column, tails),
  sayCondition: (_, condition) => written.condition(condition),
  sayFilter: (_, filter) => written.filter(filter),
  sayQuestion: (_, text) => written.question(text),
  andWords,
};

/**
 * The words for these texts — the conditions a surface is about to say —
 * with every reference among them named once its record has been read.
 */
export function useConditionWords(table: TableMeta | undefined, texts: readonly string[]): ConditionWords {
  // A change of language is a change of words.
  useMessageLanguage();
  const base = appSpeaker(table);
  const asks = !!base && texts.some((text) => text.trim());
  const [, arrived] = useState(0);
  useEffect(() => {
    if (!asks || words) return;
    let live = true;
    void load().then(() => {
      if (live) arrived((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [asks]);
  const loaded = base ? words : undefined;
  const wanted =
    base && loaded
      ? [
          ...new Map(
            texts.flatMap((text) =>
              [...loaded.referencedIds(base, text)].flatMap(([column, ids]) =>
                ids.map((id) => [`${column}\n${id}`, { column, id }] as const),
              ),
            ),
          ).values(),
        ]
      : [];
  const names = useQueries({ queries: wanted.map(({ column, id }) => referenceNameQuery(base?.column(column), id)) });
  if (!base || !loaded) return { speaker: null, ...AS_WRITTEN };
  const known = new Map(wanted.map(({ column, id }, i) => [`${column}\n${id}`, names[i]?.data ?? undefined]));
  const { sayTails, sayCondition, sayFilter, sayQuestion } = loaded;
  return {
    speaker: { ...base, recordName: (column, id) => known.get(`${column}\n${id}`) ?? undefined },
    sayTails,
    sayCondition,
    sayFilter,
    sayQuestion,
    andWords,
  };
}
