/**
 * The record layout editor: the sections of a record, each on or off,
 * reordered, renamed, and its fields arranged — with the record beside it
 * updating as you change it. The draft is one mutable object the record
 * view also reads (`template.js` holds it), so a change here is a mutation
 * and a redraw, not a copy.
 */
import { useState } from 'react';
import { findTable, state, tableAtPrefix } from '../core.js';
import { promptFor } from '../prompt.js';
import { DEFAULT_LIST_LIMIT } from '@mistriwork/engine/shared/recordview.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { FieldArranger } from './FieldArranger.js';
import type { RecoveryStatus } from '../draftRecovery.js';
import { say } from '../copy/record/components/LayoutBuilder.js';

export interface Section {
  kind: 'fields' | 'list';
  title?: string;
  off?: boolean;
  paths: string[];
  via?: string;
  columns: string[];
  limit?: number;
}
export interface Template {
  id: string;
  name?: string;
  base: string;
  sections: Section[];
}
export interface LayoutBuilderProps {
  draft: Template;
  table: TableMeta;
  /** The record beside the builder redraws, a beat later. */
  onPreview: () => void;
  /** Both redraw now. */
  onApplied: () => void;
  onReset: () => void;
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
  error?: string;
  recoveryStatus?: RecoveryStatus;
  hasRecovery?: boolean;
  recoverySourceChanged?: boolean;
  onRecover?: (restore: boolean) => void;
  canEdit?: () => boolean;
}

function childOf(section: Section): TableMeta | null {
  const fk = (state as { schema: { foreignKeys: Array<{ name: string; from: { table: string } }> } }).schema.foreignKeys.find(
    (f) => f.name === section.via,
  );
  return fk ? ((findTable(fk.from.table) as TableMeta | undefined) ?? null) : null;
}

export function LayoutBuilder({
  draft,
  table,
  onPreview,
  onApplied,
  onReset,
  onCancel,
  onSave,
  saving = false,
  error,
  recoveryStatus,
  hasRecovery = false,
  recoverySourceChanged,
  onRecover,
  canEdit = () => true,
}: LayoutBuilderProps) {
  const [, bump] = useState(0);
  const applied = () => {
    bump((n) => n + 1);
    onApplied();
  };
  const preview = () => {
    bump((n) => n + 1);
    onPreview();
  };
  const move = (index: number, delta: number) => {
    if (!canEdit()) return;
    const next = index + delta;
    if (next < 0 || next >= draft.sections.length) return;
    const [section] = draft.sections.splice(index, 1);
    draft.sections.splice(next, 0, section);
    applied();
  };
  return (
    <>
      <div className="tpl-head">
        <div className="tpl-title">
          <span className="tpl-eyebrow">{say('recordLayout')}</span>
          <input
            type="text"
            className="tpl-name"
            value={draft.name ?? ''}
            disabled={saving || hasRecovery}
            aria-label={say('layoutName')}
            placeholder={say('defaultLayout')}
            spellCheck={false}
            onChange={(e) => {
              if (canEdit()) {
                draft.name = e.currentTarget.value;
                preview();
              }
            }}
          />
          <span className="tpl-for">{say('for', { name: table.name })}</span>
        </div>
        {hasRecovery ? (
          <div className="tpl-recovery" role="status">
            <p>{recoverySourceChanged ? say('anUnsavedDraftIsAvailable') : say('anUnsavedLayoutDraft')}</p>
            <div className="tpl-head-actions">
              <button type="button" onClick={() => onRecover?.(true)}>
                {say('restoreDraft')}
              </button>
              <button type="button" className="ghost" onClick={() => onRecover?.(false)}>
                {say('discardDraft')}
              </button>
            </div>
          </div>
        ) : null}
        {recoveryStatus === 'unavailable' || recoveryStatus === 'conflict' ? (
          <p className="tpl-error" role="alert">
            {recoveryStatus === 'conflict' ? say('anotherEditorChangedTheRecovery') : say('browserRecoveryIsUnavailable')}
          </p>
        ) : null}
        {error ? (
          <p className="tpl-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="tpl-head-actions">
          <button type="button" className="ghost" disabled={saving || hasRecovery} onClick={onReset}>
            {say('resetToDefault')}
          </button>
          <button type="button" className="ghost" disabled={saving} onClick={onCancel}>
            {say('common.cancel')}
          </button>
          <button type="button" disabled={saving || hasRecovery} onClick={onSave}>
            {saving ? 'Saving...' : say('saveLayout')}
          </button>
        </div>
      </div>
      <div className="tpl-body" inert={saving || hasRecovery} aria-busy={saving}>
        {draft.sections.map((section, index) => (
          <SectionCard
            key={`${section.kind}:${section.via ?? ''}:${index}`}
            section={section}
            index={index}
            count={draft.sections.length}
            draft={draft}
            table={table}
            onMove={(delta) => move(index, delta)}
            applied={applied}
            preview={preview}
            canEdit={canEdit}
          />
        ))}
      </div>
    </>
  );
}

function SectionCard({
  section,
  index,
  count,
  draft,
  table,
  onMove,
  applied,
  preview,
  canEdit,
}: {
  section: Section;
  index: number;
  count: number;
  draft: Template;
  table: TableMeta;
  onMove: (delta: number) => void;
  applied: () => void;
  preview: () => void;
  canEdit: () => boolean;
}) {
  const isList = section.kind === 'list';
  const child = isList ? childOf(section) : null;
  const rename = async () => {
    const name = await promptFor({
      title: say('renameSection'),
      label: say('heading'),
      value: section.title ?? '',
      confirmLabel: say('common.rename'),
      hint: undefined,
      placeholder: undefined,
    });
    if (name === null || !canEdit()) return;
    section.title = name.trim() || undefined;
    applied();
  };
  return (
    <section className={`tpl-section${section.off ? ' off' : ''}`}>
      <div className="tpl-section-head">
        <label className="tpl-toggle">
          <input
            type="checkbox"
            checked={!section.off}
            onChange={(e) => {
              section.off = !e.currentTarget.checked;
              applied();
            }}
          />
          <span className="tpl-section-name">{section.title ?? say('fields')}</span>
        </label>
        <span className="tpl-section-kind">
          {isList ? say('tableNamed', { table: (child ? child.name : section.via) ?? '' }) : say('fieldsKind')}
        </span>
        <div className="tpl-section-actions">
          <button
            type="button"
            className="tpl-move"
            title={say('common.moveUp')}
            aria-label={say('common.moveUp')}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="tpl-move"
            title={say('common.moveDown')}
            aria-label={say('common.moveDown')}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="tpl-move"
            title={say('common.rename')}
            aria-label={say('renameSection')}
            onClick={() => void rename()}
          >
            ✎
          </button>
        </div>
      </div>
      {section.off ? null : isList ? (
        <ListChoices section={section} child={child} applied={applied} preview={preview} />
      ) : (
        <FieldChoices section={section} draft={draft} table={table} applied={applied} preview={preview} />
      )}
    </section>
  );
}

function FieldChoices({
  section,
  draft,
  table,
  applied,
  preview,
}: {
  section: Section;
  draft: Template;
  table: TableMeta;
  applied: () => void;
  preview: () => void;
}) {
  /* The candidates are the columns of whichever table the section's paths point into. */
  const prefix = section.paths[0]?.includes('.') ? section.paths[0].slice(0, section.paths[0].lastIndexOf('.')) : '';
  const source = (prefix ? tableAtPrefix(table.id, prefix) : table) as TableMeta | null | undefined;
  if (!source) return <p className="note">{say('thatReferenceIsNoLonger')}</p>;
  const qualify = (name: string) => (prefix ? `${prefix}.${name}` : name);
  const types = new Map(source.columns.map((c) => [qualify(c.name), c.type.toLowerCase()]));
  const others = draft.sections
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === 'fields' && s !== section && !s.off)
    .map(({ s, i }) => ({
      title: s.title || say('block', { i: i + 1 }),
      receive: (name: string) => {
        if (!s.paths.includes(name)) s.paths = [...s.paths, name];
      },
    }));
  return (
    <FieldArranger
      all={source.columns.map((c) => qualify(c.name))}
      chosen={section.paths}
      /* No label of its own: the card this sits in is headed with the block's name. */
      heading={null}
      label={(path) => (prefix && path.startsWith(`${prefix}.`) ? path.slice(prefix.length + 1) : path)}
      typeOf={(path) => types.get(path) ?? ''}
      owner={section}
      onChange={(next) => {
        section.paths = next;
        preview();
      }}
      others={others}
      onSend={applied}
    />
  );
}

function ListChoices({
  section,
  child,
  applied,
  preview,
}: {
  section: Section;
  child: TableMeta | null;
  applied: () => void;
  preview: () => void;
}) {
  if (!child) return <p className="note">{say('thatRelationshipIsNoLonger')}</p>;
  const types = new Map(child.columns.map((c) => [c.name, c.type.toLowerCase()]));
  return (
    <div>
      {/* The same arranger as a field block, because a list's columns are the same kind of choice. */}
      <FieldArranger
        heading={say('common.columns')}
        all={child.columns.map((c) => c.name)}
        chosen={section.columns}
        typeOf={(name) => types.get(name) ?? ''}
        owner={section}
        onChange={(next) => {
          section.columns = next;
          preview();
        }}
      />
      <label className="tpl-rows">
        <span>{say('rowsOnThePage')}</span>
        <input
          type="number"
          min={1}
          max={50}
          defaultValue={String(section.limit ?? (DEFAULT_LIST_LIMIT as number))}
          onChange={(e) => {
            section.limit = Math.max(1, Math.min(50, Number(e.currentTarget.value) || 8));
            applied();
          }}
        />
      </label>
    </div>
  );
}
