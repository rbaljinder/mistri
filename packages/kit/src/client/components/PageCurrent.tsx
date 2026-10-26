/**
 * A current card (`current(title, from, whose, { query, sort })`, a related
 * list with presentation 'card'): the one row the query and the sort choose —
 * the active lease of a unit, the latest visit — as the record-card a
 * reference draws (PageFields.tsx), captioned by the section's title. The
 * row's name is its title and opens it — said without the page record's own
 * name, as a child list says it ("Telehealth", not "Noah Fischer ·
 * telehealth" on Noah's page); the columns its `show` names are the facts,
 * in that order, each dressed by its display rule, and nothing else the read
 * carried to name or open the row; "View lease" says so again at the foot.
 * With no such row the card says what that means, in the author's words
 * where there are some.
 */
import type { ReactNode } from 'react';
import { columnLabel, labelPath, openRecord, state } from '../core.js';
import { opensRecord } from '../recordIntent.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Value } from './Value.js';
import { presentationColumns } from './columnPresentation.js';
import { say } from '../copy/record/components/PageCurrent.js';

export function CurrentCard({
  table,
  caption,
  row,
  columns,
  show,
  labels,
  referenceLabels,
  record,
  title,
  noun,
  empty,
}: {
  table: TableMeta;
  /** The section's title: what the card is ("Current lease"). */
  caption?: string;
  row: Record<string, unknown> | undefined;
  /** The row's shown columns, the list's private projection already left out. */
  columns: string[];
  /** The section's `show`: the facts, in its order. Without one, every shown column but the name and the key. */
  show?: readonly string[];
  labels?: Record<string, string>;
  /** Column → the joined column naming the record it references. */
  referenceLabels?: Record<string, string>;
  record: { key: Record<string, unknown> | null; label: string } | undefined;
  /** The name the card is titled by, where it says less than the record's own (its parent's name left out);
      null where it is the page's own name, which the heading already says. */
  title?: string | null;
  /** What one row is called, for the foot's "View …". */
  noun: string;
  empty: ReactNode;
}) {
  const naming = labelPath(table);
  const keys = primaryKey(table);
  /* A card titled by a computed name still reads a column to name the row by
     where the App names none: that column is the title, not a fact the
     author asked for. */
  const asked = (show?.length ? show.filter((name) => columns.includes(name)) : columns).filter(
    (name) => name !== naming && !keys.includes(name),
  );
  const facts = asked.filter((name) => row && row[name] !== null && row[name] !== undefined && row[name] !== '');
  const metadata = presentationColumns(state.schema, table, facts);
  const open = () => {
    if (record?.key) void openRecord(table.id, record.key, record.label);
  };
  return (
    <div className="page-card page-current">
      {caption && <h2 className="page-card-caption">{caption}</h2>}
      {row && record ? (
        <>
          {title !== null && (
            <p className="page-card-title">
              {record.key ? (
                <button type="button" className="ref-jump page-card-name" data-opens={opensRecord(table.id, record.key)} onClick={open}>
                  {title ?? record.label}
                </button>
              ) : (
                <span>{title ?? record.label}</span>
              )}
            </p>
          )}
          {facts.length > 0 && (
            <dl className="page-card-facts">
              {facts.map((name) => {
                const label = referenceLabels?.[name] ? row[referenceLabels[name]] : undefined;
                const col = metadata.get(name) ?? { name, type: 'TEXT', nullable: true, primaryKey: false };
                return (
                  <div key={name} className="page-card-fact">
                    <dt>{labels?.[name] ?? columnLabel(table.id, name) ?? humanName(name)}</dt>
                    <dd>
                      <Value tableId={table.id} col={label == null ? col : { ...col, type: 'TEXT' }} value={label ?? row[name]} compact />
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
          {record.key && (
            <p className="page-card-foot">
              <button type="button" className="ref-jump page-card-more" data-opens={opensRecord(table.id, record.key)} onClick={open}>
                {say('common.view', { noun })}
              </button>
            </p>
          )}
        </>
      ) : (
        <div className="page-current-empty">{empty}</div>
      )}
    </div>
  );
}
