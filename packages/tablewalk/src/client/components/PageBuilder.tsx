/**
 * The page builder: a page's sections — fields, counts, lists — each with
 * its title, width, offsets and its own picker of fields or columns;
 * reordered by grip or arrows; a field carried from one group of fields to
 * another. The draft is one mutable object, so every change is a mutation
 * and a redraw. Storage, the config emitter and the entry points stay in
 * `pagebuilder.js`.
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { findTable, refsFrom, tableAtPrefix, toast } from '@mistriwork/kit/client/core.js';
import {
  FIELD_COLUMNS,
  OFFSETS,
  WIDTHS,
  type PageFields,
  type PageList,
  type PageMetric,
  type PageBreakdown,
  type PageSection,
} from '@mistriwork/engine/shared/page.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { sharedPrefix } from '@mistriwork/engine/shared/pagePaths.js';
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import { FieldArranger, carriedField } from '@mistriwork/kit/client/components/FieldArranger.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { ConfirmDialog, PromptDialog } from '@mistriwork/kit/client/components/Prompt.js';
import { asConfig, checkedDraft, type PageDraft } from './pageDraft.js';
import type { RecoveredPageDraft, RecoveryStatus } from '../pageDraftRecovery.js';
import type { PagePreviewContext } from '@mistriwork/kit/client/components/PagePreview.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { say } from '../copy/workbench/components/PageBuilder.js';
import { addHostListener, popupContainer, removeHostListener } from '@mistriwork/kit/client/shellHost.js';

const PagePreview = lazy(() =>
  import('@mistriwork/kit/client/components/PagePreview.js').then((module) => ({ default: module.PagePreview })),
);

export type { PageDraft } from './pageDraft.js';
type Section = PageSection;
export interface Relation {
  from: string;
  path: string;
  label: string;
  hops: number;
  via: string[];
  aliases?: string[];
  all?: string[];
  defaults?: string[];
  columns?: string[];
}
export interface Reference {
  of: string;
  via: string;
  targetName: string;
  relations: Relation[];
}
export interface PageBuilderProps {
  draft: PageDraft;
  /** File/schema pages are edited as copies, not overwritten or deleted. */
  derived: boolean;
  original: PageDraft;
  relations: Relation[];
  references: Reference[];
  destination?: string;
  recovery?: RecoveredPageDraft;
  recoverySourceChanged?: boolean;
  recoveryStatus?: RecoveryStatus;
  onDraftChange?: (draft: PageDraft) => RecoveryStatus;
  onDiscard?: () => RecoveryStatus;
  previewContext?: PagePreviewContext;
  onClose: () => void;
  onSave: (draft: PageDraft) => Promise<void>;
  onDelete: (page: PageDraft) => Promise<void>;
}

/* The section being carried, while it is being carried: the row under the pointer and the row being dragged are two closures that never meet. */
let sectionDrag: number | null = null;

const fieldsOf = (draft: PageDraft, target: PageFields) =>
  target.paths ?? (findTable(draft.base) as TableMeta | undefined)?.columns.map((c) => c.name) ?? [];
function receiveField(draft: PageDraft, target: PageFields, name: string) {
  const into = fieldsOf(draft, target);
  target.paths = into.includes(name) ? into : [...into, name];
}

export function PageBuilder({
  draft,
  derived,
  original,
  relations,
  references,
  destination = say('thisServerConnection'),
  recovery,
  recoverySourceChanged,
  recoveryStatus,
  onDraftChange,
  onDiscard,
  previewContext,
  onClose,
  onSave,
  onDelete,
}: PageBuilderProps) {
  const panel = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const [initial] = useState(() => JSON.stringify(draft));
  const [recoveryChoice, setRecoveryChoice] = useState(Boolean(recovery));
  const [localStatus, setLocalStatus] = useState(recoveryStatus);
  const [formVersion, setFormVersion] = useState(0);
  const [preview, setPreview] = useState<PageDraft | null>(null);
  const [discard, setDiscard] = useState(false);
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const errorBox = useRef<HTMLParagraphElement>(null);
  const inFlight = useRef(false);
  const [sectionKey] = useState(() => {
    const keys = new WeakMap<PageSection, number>();
    let next = 0;
    return (section: PageSection) => {
      const known = keys.get(section);
      if (known !== undefined) return known;
      const key = next++;
      keys.set(section, key);
      return key;
    };
  });
  const [prompt, setPrompt] = useState<{ kind: 'delete' } | { kind: 'copy'; text: string } | null>(null);
  const [, bump] = useState(0);
  const draw = () => {
    setLocalStatus(onDraftChange?.(draft));
    bump((n) => n + 1);
  };
  const resolveRecovery = (restore: boolean) => {
    if (restore && recovery) {
      for (const key of Object.keys(draft)) delete (draft as unknown as Record<string, unknown>)[key];
      Object.assign(draft, structuredClone(recovery.draft));
      draw();
    } else setLocalStatus(onDiscard?.());
    setRecoveryChoice(false);
    setFormVersion((n) => n + 1);
  };
  useLayoutEffect(() => {
    if (formVersion) name.current?.focus();
  }, [formVersion]);
  /* Which section has its panel open, if any. One at a time. */
  const [open, setOpen] = useState(-1);
  const refocusSection = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (refocusSection.current === null) return;
    panel.current?.querySelectorAll('.pb-section')[refocusSection.current]?.querySelector<HTMLButtonElement>('.pb-fields-btn')?.focus();
    refocusSection.current = null;
  }, [open]);
  const requestClose = () => {
    if (inFlight.current) return;
    if (JSON.stringify(draft) !== initial) setDiscard(true);
    else onClose();
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(draft) === initial && !inFlight.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    addHostListener(window, 'beforeunload', warn);
    return () => removeHostListener(window, 'beforeunload', warn);
  }, [draft, initial]);
  useLayoutEffect(() => {
    if (error) errorBox.current?.focus();
  }, [error]);

  const persist = async (operation: 'save' | 'delete') => {
    if (inFlight.current) return;
    if (operation === 'save' && !draft.sections.length) {
      toast(say('aPageNeedsAtLeast'), 'error');
      return;
    }
    inFlight.current = true;
    setPending(operation);
    setError('');
    try {
      if (operation === 'save') await onSave(checkedDraft(draft));
      else await onDelete(original);
    } catch (err) {
      setError(
        say(operation === 'save' ? 'pageSaveNotConfirmed' : 'pageDeletionNotConfirmed', {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const copyJson = async () => {
    let text: string;
    try {
      text = asConfig(checkedDraft(draft));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(say('copiedPageConfigurationNoProject'), 'ok');
    } catch {
      setPrompt({ kind: 'copy', text });
    }
  };
  const push = (section: Section) => {
    draft.sections.push(section);
    draw();
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(next, details) => {
        if (next) return;
        details.cancel();
        if (inFlight.current) return;
        // Menus dismiss themselves first; the inline field arranger is the next layer.
        if (details.reason === 'escape-key' && open >= 0) {
          refocusSection.current = open;
          setOpen(-1);
          return;
        }
        requestClose();
      }}
    >
      <Dialog.Portal container={popupContainer()}>
        <Dialog.Backdrop className="pb-backdrop" />
        <Dialog.Popup ref={panel} className="pb" aria-label={say('editPage')} initialFocus={name} aria-busy={pending !== null}>
          <div className="pb-head">
            <h2 className="pb-title">{derived ? say('newPage') : say('editPage')}</h2>
            <span className="pb-base">{say('aboutOne', { base: draft.base })}</span>
            <Dialog.Close
              disabled={pending !== null}
              render={<button type="button" className="ghost pb-close" aria-label={say('common.close')} />}
            >
              ×
            </Dialog.Close>
          </div>
          {recoveryChoice && recovery && (
            <div className="pb-recovery" role="region" aria-label={say('recoverPageDraft')}>
              <p>
                {say('unsavedDraft')} {recovery.draft.name || say('common.untitled')}{' '}
                <time dateTime={new Date(recovery.updatedAt).toISOString()}>{formatDateTime(recovery.updatedAt)}</time>
              </p>
              {recoverySourceChanged && <p role="alert">{say('theOriginalPageHasChanged')}</p>}
              <button type="button" className="primary" onClick={() => resolveRecovery(true)}>
                {say('restoreDraft')}
              </button>
              <button type="button" className="ghost" onClick={() => resolveRecovery(false)}>
                {say('discardRecoveredDraft')}
              </button>
            </div>
          )}
          <div key={`name-${formVersion}`} className="pb-name-row" inert={pending !== null || recoveryChoice}>
            <label className="pb-label">{say('common.name')}</label>
            <input
              ref={name}
              aria-label={say('pageName')}
              className="pb-input"
              defaultValue={draft.name}
              onInput={(e) => {
                draft.name = e.currentTarget.value;
                draw();
              }}
            />
            {/* Tabs are the default, so this is the way out of them: a fact about the page, beside the name. */}
            <label className="pb-tabs-toggle" title={say('listsThatSitNext')}>
              <input
                type="checkbox"
                checked={draft.listTabs !== false}
                onChange={(e) => {
                  draft.listTabs = e.currentTarget.checked ? undefined : false;
                  draw();
                }}
              />
              <span>{say('listsAsTabs')}</span>
            </label>
          </div>
          <div key={`sections-${formVersion}`} className="pb-body" inert={pending !== null || recoveryChoice}>
            {draft.sections.length ? (
              draft.sections.map((section, i) => (
                <SectionRow
                  key={sectionKey(section)}
                  draft={draft}
                  section={section}
                  index={i}
                  relations={relations}
                  references={references}
                  draw={draw}
                  open={open}
                  setOpen={setOpen}
                />
              ))
            ) : (
              <p className="note">{say('noSectionsYetAdd')}</p>
            )}
          </div>
          <div className="pb-add" inert={pending !== null || recoveryChoice}>
            <span className="pb-label">{say('common.add')}</span>
            <AddFields draft={draft} push={push} />
            <AddRelation label={say('count')} kind="metric" draft={draft} relations={relations} references={references} push={push} />
            <AddRelation label={say('list')} kind="list" draft={draft} relations={relations} references={references} push={push} />
          </div>
          {error && (
            <p ref={errorBox} className="pb-error" role="alert" tabIndex={-1}>
              {error}
            </p>
          )}
          {localStatus && localStatus !== 'empty' && (
            <p
              className={`pb-recovery-status${localStatus === 'unavailable' || localStatus === 'conflict' ? ' pb-error' : ''}`}
              role={localStatus === 'unavailable' || localStatus === 'conflict' ? 'alert' : undefined}
              aria-live="polite"
            >
              {localStatus === 'stored'
                ? say('draftRecoveryStoredInThisBrowser')
                : localStatus === 'unavailable'
                  ? say('browserDraftStorageIsUnavailable')
                  : say('anotherEditorChangedTheRecovery')}
            </p>
          )}
          <div className="pb-foot">
            {/* Config and suggested pages are edited as copies, never deleted here. */}
            {derived ? null : (
              <button
                type="button"
                disabled={pending !== null || recoveryChoice}
                className="ghost pb-delete"
                title={say('deleteSavedPage', { name: original.name })}
                onClick={() => setPrompt({ kind: 'delete' })}
              >
                {say('delete')}
              </button>
            )}
            <button
              type="button"
              disabled={pending !== null || recoveryChoice}
              className="ghost pb-json"
              title={say('pasteIntoTablewalkJson')}
              onClick={() => void copyJson()}
            >
              {say('copyAsJson')}
            </button>
            {previewContext && (
              <button
                type="button"
                className="ghost"
                disabled={pending !== null || recoveryChoice}
                onClick={() => {
                  try {
                    setPreview(checkedDraft(draft));
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                {say('preview')}
              </button>
            )}
            <span className="pb-spacer" />
            <span className="pb-status" role="status">
              {pending === 'save' ? say('common.saving') : pending === 'delete' ? say('deleting') : say('destination', { destination })}
            </span>
            <Dialog.Close disabled={pending !== null} render={<button type="button" className="ghost" />}>
              {say('common.cancel')}
            </Dialog.Close>
            <button type="button" disabled={pending !== null || recoveryChoice} className="primary" onClick={() => void persist('save')}>
              {say('common.save')}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
      {discard && (
        <ConfirmDialog
          title={say('discardUnsavedChanges')}
          body={say('yourChangesToThisPage')}
          confirmLabel={say('discardChanges')}
          cancelLabel={say('keepEditing')}
          onDone={(confirmed) => {
            setDiscard(false);
            if (confirmed) {
              onDiscard?.();
              onClose();
            }
          }}
        />
      )}
      {prompt?.kind === 'delete' && (
        <PromptDialog
          title={say('deleteName', { name: original.name })}
          label={say('typeThePageName')}
          placeholder={original.name}
          hint={say('thisDeletesTheSaved')}
          confirmLabel="Delete"
          onDone={(value) => {
            setPrompt(null);
            if (value?.trim() === original.name) void persist('delete');
          }}
        />
      )}
      {prompt?.kind === 'copy' && (
        <PromptDialog
          title={say('copyThisIntoTablewalk')}
          label={say('common.page')}
          value={prompt.text}
          multiline
          confirmLabel={say('common.done')}
          onDone={() => setPrompt(null)}
        />
      )}
      {preview && previewContext && (
        <Suspense fallback={<p role="status">{say('loadingPreview')}</p>}>
          <PagePreview {...previewContext} draft={preview} onClose={() => setPreview(null)} />
        </Suspense>
      )}
    </Dialog.Root>
  );
}

/** A menu that opens upward from its button, closed by any item chosen; the search inside it, when there is one, takes focus. */
function Picker({ label, children, onToggle }: { label: string; children: ReactNode; onToggle?: (open: boolean) => void }) {
  return (
    <DropMenu
      className="pb-picker"
      triggerClassName="ghost pb-add-btn"
      label={label}
      popupClassName="pb-menu"
      side="top"
      align="start"
      sideOffset={4}
      onOpenChange={onToggle}
    >
      {children}
    </DropMenu>
  );
}

function AddFields({ draft, push }: { draft: PageDraft; push: (s: Section) => void }) {
  const base = findTable(draft.base) as TableMeta | undefined;
  type Fk = { name: string; from: { columns: string[] }; to: { table: string; columns: string[] } };
  const outgoing = ((base ? refsFrom(base.id) : []) as Fk[])
    .filter((fk) => fk.to.table !== draft.base)
    .map((fk) => ({ fk, target: findTable(fk.to.table) as TableMeta | undefined }))
    .filter((x): x is { fk: Fk; target: TableMeta } => Boolean(x.target));
  /* With nothing to reference there is no choice to make, and a menu with one item is a button wearing a menu. */
  if (!outgoing.length)
    return (
      <button type="button" className="ghost" onClick={() => push({ kind: 'fields', width: 'full' })}>
        {say('fields')}
      </button>
    );
  const hop = (fk: Fk) => (fk.from.columns.length === 1 ? fk.from.columns[0] : fk.name);
  const item = (prefix: string, viaText: string, target: TableMeta, lastFk: Fk) => (
    <DropItem
      key={prefix}
      className="pb-menu-item"
      title={`${viaText} → ${target.name}`}
      onClick={() => {
        /* Everything but the key it was reached by: the value is already on the row above. */
        push({
          kind: 'fields',
          title: say('nameVia', { name: target.name, viaText }),
          paths: target.columns
            .filter((c) => c.name !== lastFk.to.columns[0] || lastFk.to.columns.length > 1)
            .map((c) => `${prefix}.${c.name}`),
          width: 'full',
          columns: 2,
        });
      }}
    >
      <span className="pb-menu-label">{target.name}</span>
      <span className="pb-menu-detail">{say('viaPath', { path: viaText })}</span>
    </DropItem>
  );
  const oneAway = new Set(outgoing.map(({ target }) => target.id));
  const further = outgoing.flatMap(({ fk, target }) =>
    (refsFrom(target.id) as Fk[])
      .filter((second) => second.to.table !== draft.base && second.to.table !== target.id && !oneAway.has(second.to.table))
      .map((second) => ({ fk, second, far: findTable(second.to.table) as TableMeta | undefined }))
      .filter((x): x is { fk: Fk; second: Fk; far: TableMeta } => Boolean(x.far)),
  );
  return (
    <Picker label={say('fields')}>
      <div className="pb-group">
        <h4 className="pb-group-head">{say('thisRecord')}</h4>
        <DropItem className="pb-menu-item" onClick={() => push({ kind: 'fields', width: 'full' })}>
          <span className="pb-menu-label">{base?.name ?? draft.base}</span>
          <span className="pb-menu-detail">{say('itsOwnFields')}</span>
        </DropItem>
      </div>
      <div className="pb-group">
        <h4 className="pb-group-head">{say('aRecordItPoints')}</h4>
        {outgoing.map(({ fk, target }) => item(hop(fk), fk.from.columns.join(', '), target, fk))}
      </div>
      {further.length ? (
        <div className="pb-group">
          <h4 className="pb-group-head">{say('twoReferencesAlong')}</h4>
          {further.map(({ fk, second, far }) =>
            item(`${hop(fk)}.${hop(second)}`, `${fk.from.columns.join(', ')} → ${second.from.columns.join(', ')}`, far, second),
          )}
        </div>
      ) : null}
    </Picker>
  );
}

const DISTANCE = [say('pointsStraight'), say('oneReferenceAway'), say('twoReferencesAway'), say('threeReferencesAway')];

function AddRelation({
  label,
  kind,
  draft,
  relations,
  references,
  push,
}: {
  label: string;
  kind: 'metric' | 'list';
  draft: PageDraft;
  relations: Relation[];
  references: Reference[];
  push: (s: Section) => void;
}) {
  const [needle, setNeedle] = useState('');
  const search = useRef<HTMLInputElement>(null);
  if (!relations.length && !references.length)
    return (
      <Picker label={label}>
        <p className="note">{say('nothingPointsAtThisTable')}</p>
      </Picker>
    );
  /* What is already on the page, of this kind, is not on offer. */
  const used = new Set(
    draft.sections
      .filter((s) => s.kind === 'metric' || s.kind === 'list')
      .filter((s) => s.kind === kind)
      .map((s) => `${s.of ?? ''}|${s.from}|${s.path}`),
  );
  const available = relations.filter((r) => !used.has(`|${r.from}|${r.path}`));
  const farther = references
    .map((ref) => ({ ...ref, relations: ref.relations.filter((r) => !used.has(`${ref.of}|${r.from}|${r.path}`)) }))
    .filter((ref) => ref.relations.length);
  if (!available.length && !farther.length) {
    return (
      <Picker label={label}>
        <p className="note">{kind === 'list' ? say('everyRelationshipIsAlready') : say('everyRelationshipIsAlreadyCounted')}</p>
      </Picker>
    );
  }
  const byHops = [...new Set(available.map((r) => r.hops))].sort((a, b) => a - b);
  const total = available.length + farther.reduce((n, ref) => n + ref.relations.length, 0);
  const q = needle.trim().toLowerCase();
  const hit = (text: string) => !q || text.toLowerCase().includes(q);
  const add = (relation: Relation, ref?: Reference) => {
    const title = ref ? say('of', { label: relation.label, targetName: ref.targetName }) : relation.label;
    push(
      kind === 'metric'
        ? { kind: 'metric', fn: 'count', from: relation.from, path: relation.path, ...(ref ? { of: ref.of } : {}), title, width: 'third' }
        : { kind: 'list', from: relation.from, path: relation.path, ...(ref ? { of: ref.of } : {}), title, limit: 10, width: 'half' },
    );
  };
  const groups: Array<{ title: string; items: Array<{ relation: Relation; ref?: Reference; detail: string; hay: string }> }> = [
    ...byHops.map((hops) => ({
      title: hops === 1 ? DISTANCE[0] : (DISTANCE[hops] ?? say('referencesAway', { hops })),
      items: available
        .filter((r) => r.hops === hops)
        .map((relation) => ({ relation, detail: relation.via.join('  ←  '), hay: `${relation.label} ${relation.via.join('  ←  ')}` })),
    })),
    ...farther.map((ref) => ({
      title: say('pointsAtItsVia', { targetName: ref.targetName, via: ref.via }),
      items: ref.relations.map((relation) => ({
        relation,
        ref,
        detail: say('ofItsTarget', { target: ref.targetName }),
        hay: say('labelOfItsTarget', { label: relation.label, target: ref.targetName }),
      })),
    })),
  ];
  const shown = groups.map((g) => ({ ...g, items: g.items.filter((i) => hit(i.hay)) })).filter((g) => g.items.length);
  return (
    <Picker
      label={label}
      onToggle={(isOpen) => {
        if (isOpen && total > 12) requestAnimationFrame(() => search.current?.focus());
      }}
    >
      {/* A hundred relationships is a scroll; typed into rather than clicked through.
          Its keys are its own — the menu's typeahead must not read them — except
          Escape, which is the menu's to close on. */}
      {total > 12 ? (
        <input
          ref={search}
          type="search"
          className="pb-input pb-menu-search"
          placeholder={say('filter')}
          aria-label={say('filterRelationships')}
          autoComplete="off"
          spellCheck={false}
          value={needle}
          onChange={(e) => setNeedle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation();
          }}
        />
      ) : null}
      {shown.map((group) => (
        <div key={group.title} className="pb-group">
          <h4 className="pb-group-head">{group.title}</h4>
          {group.items.map(({ relation, ref, detail }) => (
            <DropItem
              key={`${ref?.of ?? ''}|${relation.from}|${relation.path}`}
              className="pb-menu-item"
              title={
                ref ? say('ofThisRecord', { via: relation.via.join('  ←  '), targetName: ref.targetName }) : relation.via.join('  ←  ')
              }
              onClick={() => add(relation, ref)}
            >
              <span className="pb-menu-label">{relation.label}</span>
              <span className="pb-menu-detail">{detail}</span>
            </DropItem>
          ))}
        </div>
      ))}
      <p className="note" hidden={shown.length > 0}>
        {say('common.nothingMatches')}
      </p>
    </Picker>
  );
}

const WIDTH_MEANS: Record<string, string> = { full: say('aRowToItself'), half: say('twoAcross'), third: say('threeAcross') };
const METRIC_FUNCTIONS: readonly PageMetric['fn'][] = ['count', 'sum', 'avg', 'min', 'max'];
const OFFSET_SHORT: Record<string, string> = { quarter: '¼', third: '⅓', half: '½', 'two-thirds': '⅔' };
const OFFSET_MEANS: Record<string, string> = {
  quarter: say('aQuarterOfTheRow'),
  third: say('aThirdOfTheRow'),
  half: say('halfTheRow'),
  'two-thirds': say('twoThirdsOfTheRow'),
};

function relationBehind(section: PageMetric | PageList | PageBreakdown, relations: Relation[], references: Reference[]) {
  const pool = section.of ? (references.find((ref) => ref.of === section.of)?.relations ?? []) : relations;
  return pool.find((r) => r.from === section.from && (r.path === section.path || r.aliases?.includes(section.path ?? '')));
}

function SectionRow({
  draft,
  section,
  index,
  relations,
  references,
  draw,
  open,
  setOpen,
}: {
  draft: PageDraft;
  section: Section;
  index: number;
  relations: Relation[];
  references: Reference[];
  draw: () => void;
  open: number;
  setOpen: (i: number) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [draggable, setDraggable] = useState(false);
  const [mark, setMark] = useState<'above' | 'below' | 'field' | null>(null);
  const [carrying, setCarrying] = useState(false);
  const editSections = (change: () => void) => {
    const expanded = draft.sections[open];
    change();
    setOpen(expanded ? draft.sections.indexOf(expanded) : -1);
    draw();
  };
  const move = (to: number) => {
    if (to < 0 || to >= draft.sections.length) return;
    editSections(() => {
      const [moved] = draft.sections.splice(index, 1);
      draft.sections.splice(to, 0, moved);
    });
  };
  const isFields = section.kind === 'fields';
  const relation = section.kind === 'metric' || section.kind === 'list' ? relationBehind(section, relations, references) : null;
  const fieldsPrefix = isFields ? (sharedPrefix(section.paths) as string) : '';
  const fieldsTable = isFields
    ? ((fieldsPrefix ? tableAtPrefix(draft.base, fieldsPrefix) : findTable(draft.base)) as TableMeta | undefined)
    : null;
  const all = isFields
    ? (fieldsTable?.columns.map((c) => c.name) ?? [])
    : (relation?.all ?? (findTable('from' in section ? section.from : '') as TableMeta | undefined)?.columns.map((c) => c.name) ?? []);
  /* A record section says `all N`, because that is what no selection means; a list says `default`. */
  const chosen = isFields ? section.paths : section.kind === 'list' ? section.columns : undefined;
  const countLabel = chosen?.length
    ? say('chosenOfAll', { chosen: chosen.length, all: all.length })
    : isFields
      ? say('allCount', { count: all.length })
      : 'default';
  const listTable = section.kind === 'list' ? (findTable(section.from ?? '') as TableMeta | undefined) : null;
  const numeric = section.kind === 'metric' ? (relation?.columns ?? []) : [];
  const holds = isFields
    ? say('tableFields', {
        table:
          (fieldsPrefix
            ? (tableAtPrefix(draft.base, fieldsPrefix) as TableMeta | null)?.name
            : (findTable(draft.base) as TableMeta | undefined)?.name) ?? draft.base,
      })
    : null;

  const onDragOver = (e: React.DragEvent) => {
    /* A section being carried takes precedence: both drags land on the same rows. */
    if (sectionDrag !== null) {
      if (sectionDrag === index) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // screen-px: compared against e.clientY, which speaks the same screen pixels.
      const box = row.current!.getBoundingClientRect();
      setMark(e.clientY > box.top + box.height / 2 ? 'below' : 'above');
      return;
    }
    const drag = carriedField();
    if (section.kind !== 'fields' || !drag || drag.owner === section) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setMark('field');
  };
  const onDrop = (e: React.DragEvent) => {
    if (sectionDrag !== null) {
      e.preventDefault();
      setMark(null);
      // screen-px: same ruler as e.clientY.
      const box = row.current!.getBoundingClientRect();
      const below = e.clientY > box.top + box.height / 2;
      const from = sectionDrag;
      sectionDrag = null;
      /* Insert-before semantics, corrected for the row that is about to leave the list. */
      let to = below ? index + 1 : index;
      if (from < to) to -= 1;
      if (to === from) {
        draw();
        return;
      }
      editSections(() => {
        const [moved] = draft.sections.splice(from, 1);
        draft.sections.splice(to, 0, moved);
      });
      return;
    }
    if (section.kind !== 'fields') return;
    e.preventDefault();
    setMark(null);
    const drag = carriedField();
    if (!drag || drag.owner === section) return;
    drag.take();
    receiveField(draft, section, drag.name);
    draw();
  };
  const rowNode = (
    <div
      ref={row}
      draggable={draggable || undefined}
      className={`pb-section pb-${section.kind}${open === index ? ' pb-open' : ''}${section.hidden ? ' pb-hidden' : ''}${carrying ? ' pb-dragging' : ''}${mark === 'above' ? ' pb-drop-above' : ''}${mark === 'below' ? ' pb-drop-below' : ''}${mark === 'field' ? ' pb-drop' : ''}`}
      onDragStart={(e) => {
        sectionDrag = index;
        setCarrying(true);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index));
        /* Stops the row from also being read as a field drop target while it is the thing being carried. */
        e.stopPropagation();
      }}
      onDragEnd={() => {
        sectionDrag = null;
        setDraggable(false);
        setCarrying(false);
        setMark(null);
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setMark(null)}
      onDrop={onDrop}
    >
      {/* The order of these rows is the order of the page, so dragging one is the natural edit. */}
      <span
        className="pb-section-grip"
        title={say('dragToReorder')}
        aria-hidden="true"
        onMouseDown={() => setDraggable(true)}
        onMouseUp={() => setDraggable(false)}
      >
        ∷
      </span>
      <span className="pb-kind">{section.kind}</span>
      <input
        className="pb-input pb-title-input"
        defaultValue={section.title ?? ''}
        placeholder={'from' in section ? section.from : say('common.untitled')}
        aria-label={say('sectionTitle')}
        onInput={(e) => {
          section.title = e.currentTarget.value || undefined;
          draw();
        }}
      />
      {holds ? <span className="pb-holds">{holds}</span> : null}
      {section.kind === 'timeline' ? <span className="pb-holds">{say('streams', { count: section.streams.length })}</span> : null}
      {section.kind === 'fields' || section.kind === 'list' ? (
        /* Opens in place rather than in a dialog of its own. */
        <button
          type="button"
          className={`ghost pb-fields-btn${open === index ? ' open' : ''}`}
          title={isFields ? say('chooseWhichFieldsThisSection') : say('chooseWhichColumnsThisList')}
          aria-expanded={open === index}
          onClick={() => setOpen(open === index ? -1 : index)}
        >
          {countLabel}
        </button>
      ) : null}
      {section.kind === 'list' ? (
        <Dropdown
          ariaLabel={say('sort')}
          value={section.orderBy?.[0] ? `${section.orderBy[0].column}:${section.orderBy[0].direction}` : ''}
          items={[
            { value: '', label: say('defaultOrder'), detail: say('whateverTheTableGives') },
            ...(listTable?.columns.map((c) => c.name) ?? []).flatMap((c) => [
              { value: `${c}:asc`, label: `${c} ↑`, detail: say('lowestFirst') },
              { value: `${c}:desc`, label: `${c} ↓`, detail: say('highestFirst') },
            ]),
          ]}
          onChange={(v) => {
            if (!v) {
              section.orderBy = undefined;
            } else {
              const [column, direction] = v.split(':');
              section.orderBy = [{ column, direction: direction === 'desc' ? 'desc' : 'asc' }];
            }
            draw();
          }}
        />
      ) : null}
      {section.kind === 'metric' ? (
        <>
          <Dropdown
            ariaLabel={say('function')}
            value={section.fn ?? 'count'}
            items={METRIC_FUNCTIONS.map((fn) => ({
              value: fn,
              label: fn,
              detail: fn === 'count' ? say('rowsAtAnyDistance') : say('ofAColumnOne', { fn }),
              disabled: fn !== 'count' && numeric.length === 0,
            }))}
            onChange={(value) => {
              const fn = METRIC_FUNCTIONS.find((fn) => fn === value);
              if (!fn) return;
              section.fn = fn;
              if (fn === 'count') section.column = undefined;
              draw();
            }}
          />
          {section.fn !== 'count' ? (
            <Dropdown
              ariaLabel={say('column')}
              value={section.column ?? ''}
              items={[
                { value: '', label: numeric.length ? say('columnMore') : say('noNumberColumns') },
                ...numeric.map((c) => ({ value: c, label: c })),
              ]}
              onChange={(c) => {
                section.column = c || undefined;
                draw();
              }}
            />
          ) : null}
        </>
      ) : null}
      {section.kind === 'list' ? (
        <input
          className="pb-input pb-limit"
          type="number"
          min={1}
          max={100}
          defaultValue={String(section.limit ?? 10)}
          aria-label={say('rowLimit')}
          onInput={(e) => {
            section.limit = Number(e.currentTarget.value) || undefined;
            draw();
          }}
        />
      ) : null}
      {section.kind === 'list' ? (
        <Dropdown
          ariaLabel={say('tableSizing')}
          value={section.sizing ?? 'fit'}
          items={[
            { value: 'fit', label: say('fitColumns') },
            { value: 'scroll', label: say('scrollColumns') },
          ]}
          onChange={(value) => {
            if (value === 'scroll') section.sizing = 'scroll';
            else delete section.sizing;
            draw();
          }}
        />
      ) : null}
      {isFields ? (
        <div className="pb-cols">
          <Dropdown
            ariaLabel={say('fieldColumns')}
            value={String(section.columns ?? '')}
            items={[
              { value: '', label: 'fit', detail: say('asManyAsTheWidth') },
              ...FIELD_COLUMNS.map((n) => ({
                value: String(n),
                label: say('col', { n }),
                detail: n === 1 ? say('oneUnderAnother') : say('acrossFilledLeftToRight', { n }),
              })),
            ]}
            onChange={(v) => {
              section.columns = FIELD_COLUMNS.find((n) => String(n) === v);
              draw();
            }}
          />
        </div>
      ) : null}
      <div className="pb-width">
        <Dropdown
          ariaLabel={say('width')}
          value={section.width ?? 'full'}
          items={WIDTHS.map((w) => ({ value: w, label: w, detail: WIDTH_MEANS[w] }))}
          onChange={(w) => {
            section.width = WIDTHS.find((width) => width === w);
            draw();
          }}
        />
      </div>
      <Dropdown
        ariaLabel={say('sectionRegion')}
        value={section.region ?? 'main'}
        items={[
          { value: 'main', label: say('main') },
          { value: 'aside', label: say('aside') },
        ]}
        onChange={(region) => {
          if (region === 'aside') section.region = 'aside';
          else delete section.region;
          draw();
        }}
      />
      <details className="pb-advanced">
        <summary>{say('spacing')}</summary>
        {([say('left'), say('right')] as const).map((side) => {
          const key = side === 'Left' ? 'offsetLeft' : 'offsetRight';
          const glyph = side === 'Left' ? '⇥' : '⇤';
          return (
            <div key={side} className="pb-width pb-offset">
              <Dropdown
                ariaLabel={say('offset', { side })}
                value={section[key] ?? ''}
                items={[
                  { value: '', label: `${glyph} 0`, detail: say('flushWithTheRow') },
                  ...OFFSETS.map((o) => ({
                    value: o,
                    label: `${glyph} ${OFFSET_SHORT[o]}`,
                    detail: say('ofEmptySpace', { offset: OFFSET_MEANS[o] }),
                  })),
                ]}
                onChange={(o) => {
                  section[key] = OFFSETS.find((offset) => offset === o);
                  draw();
                }}
              />
            </div>
          );
        })}
      </details>
      <div className="pb-section-actions">
        {/* Hidden, not removed: removing throws away the columns, the order and the title. */}
        <button
          type="button"
          className="ghost pb-hide"
          title={section.hidden ? say('hiddenClickToShow') : say('shownClickToHide')}
          aria-label={section.hidden ? say('showThisSection') : say('hideThisSection')}
          aria-pressed={Boolean(section.hidden)}
          onClick={() => {
            section.hidden = section.hidden ? undefined : true;
            draw();
          }}
        >
          {section.hidden ? '◌' : '●'}
        </button>
        <button
          type="button"
          className="ghost"
          title={say('common.moveUp')}
          aria-label={say('common.moveUp')}
          disabled={index === 0}
          onClick={() => move(index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="ghost"
          title={say('common.moveDown')}
          aria-label={say('common.moveDown')}
          disabled={index === draft.sections.length - 1}
          onClick={() => move(index + 1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="ghost pb-remove"
          title={say('common.remove')}
          aria-label={say('removeSection')}
          onClick={() =>
            editSections(() => {
              draft.sections.splice(index, 1);
            })
          }
        >
          ×
        </button>
      </div>
    </div>
  );
  if ((section.kind !== 'fields' && section.kind !== 'list') || open !== index) return rowNode;
  return (
    <div className="pb-group-row">
      {rowNode}
      {section.kind === 'fields' ? (
        <FieldsPanel draft={draft} section={section} draw={draw} />
      ) : (
        <ColumnsPanel section={section} relation={relation ?? undefined} draw={draw} />
      )}
    </div>
  );
}

function FieldsPanel({ draft, section, draw }: { draft: PageDraft; section: PageFields; draw: () => void }) {
  const base = findTable(draft.base) as TableMeta | undefined;
  if (!base) return <div />;
  const prefix = sharedPrefix(section.paths) as string;
  const on = ((prefix ? tableAtPrefix(draft.base, prefix) : base) as TableMeta | null) ?? base;
  const qualify = (name: string) => (prefix ? `${prefix}.${name}` : name);
  const all = on.columns.map((c) => qualify(c.name));
  const types = new Map(on.columns.map((c) => [qualify(c.name), c.type]));
  return (
    <FieldArranger
      all={all}
      chosen={section.paths ?? all}
      columns={typeof section.columns === 'number' ? section.columns : 1}
      noun="page"
      heading={say('fieldsHeading')}
      label={(path) => (prefix && path.startsWith(`${prefix}.`) ? path.slice(prefix.length + 1) : path)}
      typeOf={(path) => types.get(path) ?? ''}
      owner={section}
      onChange={(next) => {
        /* Stored as no selection only when it is genuinely the default — every field, in table order. */
        const isDefault = next.length === all.length && next.every((n, i) => n === all[i]);
        section.paths = isDefault ? undefined : next;
        draw();
      }}
      others={draft.sections.flatMap((s, i) =>
        s.kind === 'fields' && s !== section
          ? [{ title: s.title || say('group', { i: i + 1 }), receive: (name: string) => receiveField(draft, s, name) }]
          : [],
      )}
      onSend={draw}
    />
  );
}

function ColumnsPanel({ section, relation, draw }: { section: PageList; relation?: Relation; draw: () => void }) {
  const all = relation?.all ?? (findTable(section.from ?? '') as TableMeta | undefined)?.columns.map((c) => c.name) ?? [];
  const defaults = relation?.defaults ?? [];
  const chosen = new Set(section.columns ?? defaults);
  const set = (names: string[]) => {
    section.columns = names;
    draw();
  };
  return (
    <div className="pb-panel">
      <div className="pb-panel-head">
        <span className="pb-label">{say('common.columns')}</span>
        <span className="pb-field-count">{say('chosenOfAll', { chosen: chosen.size, all: all.length })}</span>
        <span className="pb-spacer" />
        {/* Undefined means "whatever tablewalk would pick", which is not the same as picking those by hand. */}
        <button
          type="button"
          className="ghost"
          title={say('theColumnsTablewalkWould')}
          onClick={() => {
            section.columns = undefined;
            draw();
          }}
        >
          {say('default')}
        </button>
        <button type="button" className="ghost" onClick={() => set([...all])}>
          {say('common.all')}
        </button>
        <button type="button" className="ghost" onClick={() => set([])}>
          {say('none')}
        </button>
      </div>
      <div className="pb-field-grid">
        {all.map((name) => (
          <label key={name} className="pb-field-row">
            <input
              type="checkbox"
              checked={chosen.has(name)}
              onChange={(e) => set(all.filter((n) => (n === name ? e.currentTarget.checked : chosen.has(n))))}
            />
            <span className="pb-field-name">{name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
