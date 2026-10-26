/**
 * A page's fields section: the root record's own values, read as one row
 * and drawn in the dress the section asks for — a headline, a facts line, a
 * sheet, or the field grid, editable where the record may be changed. It
 * also names the record for the head and, in an App, hands the head the
 * editor for the record's name.
 */
import { shell } from '../shellMode.js';
import { useMessageLanguage } from './useMessageLanguage.js';
import { useContext, useEffect, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readRecordSource, shareRecordSource } from '../recordSource.js';
import { readPageFields } from './pageFieldsRead.js';
import { centsTogether, dressFor, sayValue, type DisplayRule } from './valueModel.js';
import { pathEqualityFilter, recordKey as checkedRecordKey } from '../resourceRequests.js';
import { columnDisplay, columnLabel, emptyWord, findTable, labelPath, primaryKey, rowLabel, state } from '../core.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { resourceOf } from './appRooms.js';
import { recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import { canEditRow } from '../write.js';
import { cardStem, sharedPrefix } from '@mistriwork/engine/shared/pagePaths.js';
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { Editable } from './Editable.js';
import { RefJump, Value } from './Value.js';
import { defaultFieldPaths, definedThrough, fieldsColumns } from '@mistriwork/engine/shared/recordReads.js';
import { presentationColumns } from './columnPresentation.js';
import { WorkflowStatus } from './WorkflowStatus.js';
import { api as callApi, toast } from '../core.js';
import { ownedBy } from '../requestIdentity.js';
import type { AppUpdateAction } from '@mistriwork/engine/schema/model.js';
import { PageHeadline } from './PageHeadline.js';
import { PageRenderContext, recordReadNames, usePageApi, type RecordActions, type SlotProps } from './pageContext.js';
import { Loading, SectionBox } from './PageSectionBox.js';
import { sectionClass } from './pageModel.js';
import { say } from '../copy/record/components/PageFields.js';
import { onDemand } from './onDemand.js';

const DefinedFields = onDemand(() => import('./DefinedFields.js'), 'DefinedFields', { quiet: true });

/** A property the reader cannot write but an action of theirs moves: the values it can reach, as a picker. The action is the
    ordinary one — the server judges it again — so a refusal is said as the action's own would be. */
function ActionPick({
  tableId,
  recordKey,
  column,
  value,
  actions,
  caption,
  onDone,
  connection,
}: {
  tableId: string;
  recordKey: Record<string, unknown>;
  column: string;
  value: unknown;
  actions: RecordActions;
  caption: string;
  onDone?: () => void;
  connection?: string;
}) {
  const reachable = shell().slots.useReachable(tableId, recordKey, column, actions);
  const moves = actions.list.filter(
    (action): action is AppUpdateAction =>
      !action.command &&
      Object.keys((action as AppUpdateAction).set).length === 1 &&
      column in (action as AppUpdateAction).set &&
      !(action as AppUpdateAction).reason &&
      !(action as AppUpdateAction).confirm,
  );
  const current = value === null || value === undefined ? '' : String(value);
  const options = [
    ...new Set([current, ...[...reachable].filter((next) => moves.some((action) => String(action.set[column]) === next))]),
  ].filter(Boolean);
  if (options.length < 2) return null;
  const move = async (next: string) => {
    const action = moves.find((candidate) => String(candidate.set[column]) === next);
    if (!action?.set) return;
    try {
      await callApi('/api/update', {
        ...ownedBy(connection ?? state.activeConnection ?? ''),
        table: tableId,
        key: checkedRecordKey(recordKey),
        values: action.set!,
      });
      onDone?.();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };
  return (
    <select className="page-field-pick" aria-label={caption} value={current} onChange={(event) => void move(event.target.value)}>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

/** The root's own fields — one section among several, not a record page with extras. */
export function FieldsSection({
  page,
  section,
  index,
  base,
  recordKey: key,
  foldable,
  onLabel,
  onSectionLabel,
  onEdit,
  titleOwner,
  onTitleEditor,
}: SlotProps) {
  useMessageLanguage();
  const api = usePageApi();
  const { preview, isCurrent, actions: recordActions, onGone, connection, adorn } = useContext(PageRenderContext);
  const paths = section.paths?.length ? section.paths : defaultFieldPaths(base, shell().inApp());
  const namePath = labelPath(base) as string | undefined;
  /* What it shows, its references' names, the record's name, a headline's
     second figure and the fields its actions fill a form from — built as the
     server builds it for the page's compose (shared/recordReads.ts). */
  const { fetched, labels: refLabels } = fieldsColumns(recordReadNames(), base, section);
  const data = useQuery({
    queryKey: ['page-fields', page.id, base.id, key, fetched],
    // Undo can restore the cached row; only its reconciliation read needs a
    // fresh editor source, without remounting or clearing staged drafts.
    structuralSharing: shareRecordSource,
    /* With the page's other fields sections, as one read of the row (pageFieldsRead.ts). */
    queryFn: () =>
      readRecordSource(() =>
        readPageFields(
          {
            owner: connection ?? '',
            pageId: page.id,
            base,
            filter: pathEqualityFilter(Object.fromEntries((primaryKey(base) as string[]).map((column) => [column, key[column]]))),
            columns: fetched,
          },
          (body) => api('/api/view/run', body),
        ),
      ),
    staleTime: 0,
  });
  const got = data.data && 'view' in data.data ? data.data : undefined;
  const row = got?.rows[0];
  const reachable = shell().slots.useReachable(base.id, key, section.workflow?.field, recordActions);
  useEffect(() => {
    /* The row is here, so the crumb and the pill can stop saying the key. */
    if (row) {
      const label = rowLabel(base, row);
      if (onSectionLabel) onSectionLabel(index, label);
      else onLabel?.(label);
    }
  }, [row, onSectionLabel, index]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      onSectionLabel?.(index, undefined);
    },
    [onSectionLabel, index],
  );
  /* In an App the head says the record's name, so the section that owns it
     stops repeating the field below, and where the name may be changed, the
     head is where: the same editor and Save as any other field. */
  const named = shell().inApp() && !preview && !section.of && Boolean(namePath) && !namePath!.includes('.');
  const titled = named && titleOwner === index;
  const titleColumn = titled ? base.columns.find((c) => c.name === namePath) : undefined;
  const titleEditable = Boolean(
    titleColumn && !titleColumn.primaryKey && titleColumn.writable !== false && (canEditRow(base, key) as boolean),
  );
  useEffect(() => {
    if (!onTitleEditor) return;
    if (!row || !titleEditable || !titleColumn) {
      onTitleEditor(index, undefined);
      return;
    }
    onTitleEditor(index, () => (
      <Editable
        table={base}
        row={row}
        column={titleColumn}
        recordKey={key}
        onSaved={onEdit}
        isCurrent={isCurrent}
        app
        display={(next) => <span>{next === null || next === undefined || String(next) === '' ? rowLabel(base, row) : String(next)}</span>}
      />
    ));
  }, [row, titleEditable, index]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      onTitleEditor?.(index, undefined);
    },
    [onTitleEditor, index],
  );
  /* The record's own fields found no record: the page says that once, for
     every section, and offers nothing to do to it (Page.tsx). */
  const missing = !section.of && ((data.isError && (data.error as { status?: number }).status === 404) || (Boolean(got) && !row));
  useEffect(() => {
    if (missing) onGone?.();
  }, [missing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (data.isPending) return <Loading section={section} />;
  if (data.isError) return <SectionBox section={section} body={null} foldable={false} broken={(data.error as Error).message} />;
  if (data.data && !('view' in data.data))
    return (
      <SectionBox
        section={section}
        body={null}
        foldable={false}
        broken={data.data.errors[0]?.message ?? say('theseFieldsCouldNotBeRead')}
      />
    );
  if (!row) return <SectionBox section={section} body={null} foldable={false} broken={say('common.thatRecordIsNoLonger')} />;

  const byName = new Map(base.columns.map((c) => [c.name, c]));
  const byPath = new Map((got?.resolved ?? []).map((c) => [c.path, c]));
  /* A path's column as the schema has it: the result's resolved column says
     its type but not what it references, so `employee_id.department_id`
     would otherwise read as the bare key. */
  const presented = presentationColumns(state.schema, base, paths);
  const columnAt = (path: string) =>
    (byName.get(path) ?? presented.get(path) ?? byPath.get(path)) as
      | (ColumnMeta & { references?: { table: string; column: string } })
      | undefined;
  const captionOf = (path: string) => (columnLabel(base.id, path) as string | null) ?? humanName(path.split('.').pop() ?? path);
  /* The section's money in one form: a price to the cent puts every figure beside it to the cent. Read the way Value
     reads its rule, by the column's name. */
  const cents = centsTogether(
    paths.map((path) => [columnDisplay(base.id, columnAt(path)?.name ?? '') as DisplayRule | null, row[path]] as const),
  );
  /* A fields section in the aside is a property rail unless it says otherwise: caption beside value is
     what a side panel holds. The main region keeps the summary grid. */
  const presentation = section.presentation ?? (section.region === 'aside' ? 'properties' : 'summary');
  const rail = presentation === 'properties';
  const filled = (path: string) => row[path] !== null && row[path] !== undefined && row[path] !== '';
  /* A value as a line of facts or a card says it: a reference is the record
     it names, by its label where the section fetched one, never its key. */
  const said = (path: string, compact?: boolean) => {
    const column = columnAt(path);
    const labelAt = refLabels.get(path);
    return column?.references ? (
      <RefJump
        references={column.references}
        value={row[path]}
        label={labelAt ? row[labelAt] : undefined}
        table={base}
        column={path}
        row={row}
      />
    ) : (
      <Value col={column} value={row[path]} tableId={base.id} compact={compact} row={row} cents={cents} />
    );
  };
  /* A headline is the record offered: its figure, its facts and what to do next. */
  if (section.presentation === 'headline') {
    return (
      <SectionBox
        section={section}
        foldable={false}
        body={
          <PageHeadline
            tableId={base.id}
            row={row}
            paths={paths}
            column={columnAt}
            actions={section.actions ?? []}
            subfigure={section.subfigure}
            was={section.was}
            note={section.note}
          />
        }
      />
    );
  }
  /* A facts line: the values alone, each after a dot, in the order named.
     An empty one is left out rather than said as a dash in the middle of a
     sentence; each caption stays for assistive technology. */
  if (section.presentation === 'facts') {
    return (
      <SectionBox
        section={section}
        foldable={false}
        body={
          <ul className="page-facts" aria-label={section.title ?? say('common.keyFacts')}>
            {paths.filter(filled).map((path) => {
              /* A bare number says nothing in a line of words ("1998 · 24"): it keeps its caption, in sight. A figure
                 that already says what it is (money, a percent, a unit) does not need one. */
              const bare =
                typeof row[path] === 'number' && !columnAt(path)?.references && !columnDisplay(base.id, columnAt(path)?.name ?? '');
              return (
                <li key={path} className="page-fact">
                  {bare ? (
                    <span className="page-fact-caption">{captionOf(path)} </span>
                  ) : (
                    <span className="visually-hidden">{captionOf(path)}: </span>
                  )}
                  {said(path, true)}
                </li>
              );
            })}
          </ul>
        }
      />
    );
  }
  /* A sheet: caption beside value on one row, a hairline between rows, the
     rows in `columns` columns where the room has the width. A value the
     record does not have is a row nobody needs. */
  if (section.presentation === 'table') {
    const sheetColumns = typeof section.columns === 'number' ? section.columns : undefined;
    return (
      <SectionBox
        section={section}
        foldable={foldable}
        body={
          <dl className="page-sheet" style={sheetColumns ? ({ '--page-sheet-columns': String(sheetColumns) } as CSSProperties) : undefined}>
            {paths.filter(filled).map((path) => {
              return (
                <div key={path} className="page-sheet-row">
                  <dt>{captionOf(path)}</dt>
                  <dd>{said(path)}</dd>
                </div>
              );
            })}
          </dl>
        }
      />
    );
  }
  /* A card: the record a reference names, as one box — who sells the car,
     who owns the account. Its first field is the title; a reference there
     is the named record, opening its page, and "View dealer" says so again
     at the foot for a reader who scans past a name. The rest are its facts,
     captioned without the hop they share. Never folded: a card is small, and
     a chevron on it said "optional" about the one thing a buyer checks. */
  if (section.presentation === 'card') {
    const [titlePath, ...rest] = paths;
    const titleColumn = columnAt(titlePath);
    const reference = titleColumn?.references && filled(titlePath) ? titleColumn.references : undefined;
    const titleLabel = refLabels.get(titlePath);
    const factsStem = cardStem(paths) as string;
    // The resource's own `noun` where it says one ("View seller", not "View dealer_account").
    const noun = reference
      ? recordNoun(
          resourceOf(shell().app(), reference.table)?.noun,
          (findTable(reference.table) as { name?: string } | undefined)?.name ?? reference.table,
        )
      : '';
    const jump = (className: string, text?: string) => (
      <RefJump
        references={reference!}
        value={row[titlePath]}
        label={titleLabel ? row[titleLabel] : undefined}
        table={base}
        column={titlePath}
        row={row}
        className={className}
        text={text}
      />
    );
    return (
      <section className={`${sectionClass(section)} page-card-section page-reference-card`}>
        <div className="page-card">
          {section.title && <h2 className="page-card-caption">{section.title}</h2>}
          <p className="page-card-title">
            {reference ? (
              jump('page-card-name')
            ) : filled(titlePath) ? (
              <Value col={titleColumn} value={row[titlePath]} tableId={base.id} cents={cents} />
            ) : (
              emptyWord()
            )}
          </p>
          {rest.some(filled) && (
            <dl className="page-card-facts">
              {rest.filter(filled).map((path) => (
                <div key={path} className="page-card-fact">
                  <dt>{columnLabel(base.id, path, factsStem) ?? captionOf(path)}</dt>
                  <dd>{said(path)}</dd>
                </div>
              ))}
            </dl>
          )}
          {reference && <p className="page-card-foot">{jump('page-card-more', say('common.view', { noun }))}</p>}
        </div>
      </section>
    );
  }
  /* A group of fields that all follow the same reference is that record
     shown inline; its labels drop the hop they all share. */
  const stem = sharedPrefix(paths) as string;
  const shared = stem ? `${stem}.` : '';
  const own = !section.of && !stem;
  const editing = !preview && own && (canEditRow(base, key) as boolean);

  /* A group that follows a reference to nothing — "Converted to" on a lead
     that has not been — is one dash, not four labels over four dashes. */
  if (stem && shell().inApp() && paths.length && paths.every((p) => row[p] === null || row[p] === undefined)) {
    return (
      <SectionBox
        section={section}
        foldable={foldable}
        body={
          <p className="page-group-empty" title={say('nothingHereEveryField')}>
            —
          </p>
        }
      />
    );
  }

  const bound = resourceOf(shell().app(), base.id)?.defined;
  const definedOf = (id: string) => resourceOf(shell().app(), id)?.defined;
  const fields = (named ? paths.filter((path) => path !== namePath) : paths).map((path) => {
    const value = row[path];
    const column = columnAt(path);
    /* A row-defined column is its fields, each drawn here as one of the record's own (DefinedFields.tsx). */
    if (own && bound && Object.hasOwn(bound, path))
      return (
        <DefinedFields
          key={path}
          base={base}
          row={row}
          column={path}
          binding={bound[path]}
          recordKey={key}
          editing={editing && column?.writable !== false}
          onSaved={onEdit}
          isCurrent={isCurrent}
          connection={connection}
        />
      );
    /* And through a reference (`requested_item_id.answers`): the referenced
       record's fields, read here as they are on its own page, not its JSON. */
    const through = own && bound && Object.hasOwn(bound, path) ? undefined : definedThrough(state.schema, base.id, path, definedOf);
    if (through && through.prefix) {
      const per = through.binding.per;
      return (
        <DefinedFields
          key={path}
          base={through.table}
          row={{ [through.column]: value, ...(per ? { [per]: row[`${through.prefix}.${per}`] } : {}) }}
          column={through.column}
          binding={through.binding}
          recordKey={{}}
          editing={false}
          isCurrent={isCurrent}
          connection={connection}
        />
      );
    }
    let dd: ReactNode;
    /* The host's word at this field (a suggestion waiting on it): in the empty mark's place, or after the value on
       its line — the field's height is the same with it as without, so nothing below moves when it arrives. */
    const adorned =
      adorn && own && !editing && !preview && byName.has(path)
        ? adorn({ table: base.id, column: path, key, filled: value !== null && value !== undefined && value !== '' })
        : null;
    if (editing && byName.has(path) && !column?.primaryKey && column?.writable !== false) {
      const display = (next: unknown, referenceLabel?: string) =>
        column?.references && next !== null && next !== undefined && String(next) !== '' ? (
          <RefJump
            references={column.references}
            value={next}
            label={referenceLabel ?? (String(next) === String(value) && refLabels.get(path) ? row[refLabels.get(path)!] : undefined)}
            table={base}
            column={path}
            row={{ ...row, [path]: next }}
          />
        ) : (
          /* A record's own field is where rich text is read whole; a list or a card shows its excerpt. */
          <Value col={column} value={next} tableId={base.id} compact links wholeText cents={cents} />
        );
      dd = (
        <dd className="page-field-edit">
          <Editable
            table={base}
            row={row}
            column={byName.get(path)!}
            recordKey={key}
            onSaved={onEdit}
            isCurrent={isCurrent}
            app={shell().inApp()}
            display={shell().inApp() ? display : undefined}
          />
        </dd>
      );
    } else if (
      section.edit &&
      !preview &&
      own &&
      recordActions &&
      byName.has(path) &&
      !column?.primaryKey &&
      recordActions.list.some(
        (action) => !action.command && Object.keys((action as { set: object }).set).length === 1 && path in (action as { set: object }).set,
      )
    ) {
      dd = (
        <dd className="page-field-edit">
          <ActionPick
            tableId={base.id}
            recordKey={key}
            column={path}
            value={value}
            actions={recordActions}
            caption={columnLabel(base.id, path, stem) ?? path}
            onDone={onEdit}
            connection={connection}
          />
        </dd>
      );
    } else if (value === null || value === undefined) {
      /* A text a section is only about, with nothing in it, is one muted line saying so, not a dash alone in the
         room of a paragraph. */
      const about = Boolean(section.title) && paths.length === 1 && !rail && column?.references === undefined;
      dd = adorned ? (
        <dd className="page-field-adorned">{adorned}</dd>
      ) : about ? (
        <dd className="page-prose-empty">{say('noneYet', { caption: (columnLabel(base.id, path, stem) ?? path).toLowerCase() })}</dd>
      ) : (
        <dd className="null" title="null">
          {emptyWord()}
        </dd>
      );
    } else if (column?.references && String(value) !== '') {
      const labelAt = refLabels.get(path);
      dd = (
        <dd>
          <RefJump
            references={column.references}
            value={value}
            label={labelAt ? row[labelAt] : undefined}
            table={base}
            column={path}
            row={row}
          />
          {adorned}
        </dd>
      );
    } else {
      dd = (
        <dd>
          <Value col={column} value={value} tableId={base.id} row={row} cents={cents} />
          {adorned}
        </dd>
      );
    }
    const shownAs = shared ? path.slice(shared.length) : path;
    const label = columnLabel(base.id, path, stem) ?? shownAs;
    /* A titled group that holds only its own field says its name once: the
       section's title stands for the field's label, which stays for
       assistive technology. A property rail is caption beside value by its
       shape, so its one row keeps the caption: "Mar 31, 2026" alone under
       "Completed" read as a stray value, not a rail. */
    /* Text to read rather than a value to glance at goes under its caption at the
       rail's whole width, as a document says it (Document.tsx): beside
       its caption in an aside, Depot's product description wrapped word by word. */
    const rule = columnDisplay(base.id, path) as DisplayRule | null;
    const dress = column?.references || value === null || value === undefined ? null : dressFor(rule, value);
    const long =
      rule?.format === 'richText' ||
      (rail && !column?.references && value != null && (dress ? dress.kind === 'richText' : sayValue(column, value).kind === 'long'));
    /* …and a long text alone under its section's title is read under that title, as a document's paragraph. */
    const lone = Boolean(section.title) && paths.length === 1 && (!rail || long);
    /* …and set as a paragraph: body weight and size, a readable measure, never the weight of a heading. */
    const prose = lone && typeof value === 'string' && !column?.references;
    return (
      <div key={path} className={`page-field${long ? ' page-field-wide' : ''}${prose ? ' page-field-prose' : ''}`}>
        <dt title={path} className={lone ? 'visually-hidden' : undefined}>
          {label}
        </dt>
        {dd}
      </div>
    );
  });
  const columns = typeof section.columns === 'number' ? section.columns : undefined;
  /* Both are lists of terms, so both are drawn as one: a property rail says
     caption beside value, the grid says them in columns. A grid of <dt>/<dd>
     in a <div> had no list for assistive technology to announce. */
  const grid = rail ? (
    <dl className="page-properties" style={columns ? ({ '--page-properties-columns': String(columns) } as CSSProperties) : undefined}>
      {fields}
    </dl>
  ) : (
    <dl
      className={`page-field-grid${presentation === 'summary' ? ' page-field-summary' : ''}`}
      data-columns={columns}
      style={columns ? ({ '--page-field-columns': `repeat(${columns}, minmax(0, 1fr))` } as CSSProperties) : undefined}
    >
      {fields}
    </dl>
  );
  return (
    <SectionBox
      section={section}
      foldable={foldable}
      body={
        <>
          {section.workflow && <WorkflowStatus definition={section.workflow} value={row[section.workflow.field]} reachable={reachable} />}
          {grid}
        </>
      }
    />
  );
}
