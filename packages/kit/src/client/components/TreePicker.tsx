/**
 * A reference picker over a hierarchy: a reference whose records hang from one another by a parent column
 * (`tree: 'parent_id'`, on a command's reference and on a New form's field). A category three levels down is found
 * by walking to it, not by remembering its exact name, and once chosen it is said with its path — Hardware ›
 * Laptops › Batteries — so two records of one name under different parents are told apart.
 *
 * The box is a combobox (APG) whose popup is the tree: focus stays in the box, the lit row is its active
 * descendant. Up and Down move through what is open, Right opens a branch or steps into it, Left folds it or steps
 * out to its parent, Home and End go to the ends, Enter chooses, Escape closes. Typing searches every level at once,
 * the popup a list of matches each said with its path; clearing the box goes back to the tree.
 *
 * Read lazily, a level at a time: the records with no parent when the box opens, a branch's children when it is
 * opened, and for each level one breakdown says which of its records have children, so a leaf draws no caret and
 * nothing is read per record. A record whose parent the field's own filter leaves out is not under any branch; a
 * search finds it. A path is read upward a level per request, bounded, and a loop in the data ends it.
 *
 * Every read is the reader's own (`ask`): the reader's connection, or a public form's visitor read, so the tree
 * offers only the records its reader may read, as a flat picker does. Nothing slides open (motion rule 8).
 */
import './TreePicker.css';
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Popover } from '@base-ui/react/popover';
import { layoutViewport, zoomAnchor } from '@mistriwork/ui/internal/anchor.js';
import { viewportBox } from '@mistriwork/ui/internal/ruler.js';
import { popupContainer, shellById } from '../shellHost.js';
import { andQuery, quoteValue } from '@mistriwork/engine/shared/query.js';
import { Icon } from './Icon.js';
import { formatNumber } from '../locale.js';
import { say } from '../copy/forms/components/TreePicker.js';

/** A level's records read at once; past it the level says so, and a search finds the rest. */
const LEVEL = 200;
/** A search's matches. */
const MATCHES = 20;
/** How far up a path is read. */
const DEPTH = 12;

export type TreeValue = string | number;
type Row = Record<string, unknown>;
/** One read, as the reader may make it: `/api/run` for rows, `/api/breakdown` for which rows have children. */
export type TreeAsk = (
  path: '/api/run' | '/api/breakdown',
  body: Record<string, unknown>,
) => Promise<{ rows?: unknown; errors?: unknown[] }>;

interface TreeNode {
  key: string;
  value: TreeValue;
  label: string;
  parent: string | null;
}
type Level = readonly string[] | 'loading' | 'error';
interface Line {
  key: string;
  depth: number;
  node?: TreeNode;
  note?: string;
  /** A match's ancestors, said beside it. */
  path?: readonly string[];
}

interface TreePickerProps {
  /** The table (or resource) the records are read from, as query text starts. */
  from: string;
  /** Its key column: the value kept. */
  by: string;
  /** The column each record is said by. */
  labelColumn: string;
  /** The column naming each record's parent, by `by`. */
  parent: string;
  /** Only the records this condition admits (the field's own filter). */
  where?: string;
  ask: TreeAsk;
  /** Who reads, for the answers kept between opens: a reader's answers are never another's. */
  scope: string;
  value: TreeValue | '' | undefined;
  onChange: (value: TreeValue | '', label?: string) => void;
  /** The chosen record's name where the caller has it already. */
  known?: string;
  id?: string;
  /** The box's name where no `<label for>` gives it one. */
  ariaLabel?: string;
  /** What the popup is called where the box is named by its `<label>`: the field's caption. */
  listLabel?: string;
  describedBy?: string;
  invalid?: boolean;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
}

const blank = (value: unknown) => value === null || value === undefined || value === '';

export function TreePicker({
  from,
  by,
  labelColumn,
  parent,
  where,
  ask,
  scope,
  value,
  onChange,
  known,
  id,
  ariaLabel,
  listLabel,
  describedBy,
  invalid,
  required,
  disabled,
  placeholder,
  inputRef,
}: TreePickerProps) {
  const client = useQueryClient();
  const base = useId();
  const listId = `${base}-tree`;
  const trailId = `${base}-trail`;
  const [nodes, setNodes] = useState<ReadonlyMap<string, TreeNode>>(new Map());
  const [kids, setKids] = useState<ReadonlyMap<string, Level>>(new Map());
  const [cut, setCut] = useState<ReadonlySet<string>>(new Set());
  const [branches, setBranches] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [typed, setTyped] = useState(false);
  const [asked, setAsked] = useState('');
  const [matches, setMatches] = useState<{ for: string; keys: readonly string[] } | { for: string; error: true }>();
  const [active, setActive] = useState<string>();
  const known$ = useRef(nodes);
  known$.current = nodes;
  const requested = useRef(new Set<string>());

  /* The answers belong to their reader and their question: a new one starts the tree again. */
  const question = JSON.stringify([scope, from, by, labelColumn, parent, where ?? '']);
  const [held, setHeld] = useState(question);
  if (held !== question) {
    setHeld(question);
    setNodes(new Map());
    setKids(new Map());
    setCut(new Set());
    setBranches(new Map());
    setOpened(new Set());
    setMatches(undefined);
    requested.current = new Set();
  }

  const shown = `show ${[...new Set([by, labelColumn, parent])].join(', ')}`;
  const nodeOf = (row: Row | undefined): TreeNode | null => {
    const key = row?.[by];
    if (!(typeof key === 'string' || (typeof key === 'number' && Number.isSafeInteger(key)))) return null;
    const up = row![parent];
    return { key: String(key), value: key, label: String(row![labelColumn] ?? key), parent: blank(up) ? null : String(up) };
  };
  const learn = (found: readonly TreeNode[]) => {
    if (!found.length) return;
    const next = new Map(known$.current);
    for (const node of found) next.set(node.key, node);
    known$.current = next;
    setNodes(next);
  };
  const rowsOf = (q: string, limit: number) =>
    client.fetchQuery({
      queryKey: ['tree-picker', scope, q, limit],
      staleTime: 30_000,
      queryFn: async () => {
        const data = await ask('/api/run', { q, limit, offset: 0, count: 'none' });
        if (data.errors?.length || !Array.isArray(data.rows)) throw new Error(say('couldNotLoad'));
        return data.rows as Row[];
      },
    });
  /* Which of a level's records have children: one breakdown of the parent column over them, never a read each. */
  const parentsAmong = (values: readonly TreeValue[]) =>
    client.fetchQuery({
      queryKey: ['tree-picker', scope, 'branches', from, parent, where ?? '', values],
      staleTime: 30_000,
      queryFn: async () => {
        const text = `${from} ${andQuery(where, `${parent} in (${values.map(quoteValue).join(', ')})`)} count as children by ${parent}`;
        const data = await ask('/api/breakdown', { text, limit: values.length });
        if (data.errors?.length || !Array.isArray(data.rows)) throw new Error(say('couldNotLoad'));
        return new Set((data.rows as Row[]).filter((row) => Number(row.children) > 0).map((row) => String(row[parent])));
      },
    });

  const level = async (key: string) => {
    if (requested.current.has(key)) return;
    requested.current.add(key);
    setKids((was) => new Map(was).set(key, 'loading'));
    const above = known$.current.get(key);
    const condition = key === '' ? `${parent} is empty` : `${parent} = ${quoteValue(above ? above.value : key)}`;
    try {
      const rows = await rowsOf(`${from} ${andQuery(where, condition)} ${shown} sort ${labelColumn}`, LEVEL + 1);
      const found = rows
        .slice(0, LEVEL)
        .map(nodeOf)
        .filter((node): node is TreeNode => node !== null);
      learn(found);
      setKids((was) =>
        new Map(was).set(
          key,
          found.map((node) => node.key),
        ),
      );
      if (rows.length > LEVEL) setCut((was) => new Set(was).add(key));
      if (key !== '') setBranches((was) => new Map(was).set(key, found.length > 0));
      if (!found.length) return;
      /* Unknown where the breakdown cannot be read: such a record draws its caret and is settled when opened. */
      const has = await parentsAmong(found.map((node) => node.value)).catch(() => undefined);
      if (has)
        setBranches((was) => {
          const next = new Map(was);
          for (const node of found) if (!next.has(node.key) || next.get(node.key) !== false) next.set(node.key, has.has(node.key));
          return next;
        });
    } catch {
      requested.current.delete(key);
      setKids((was) => new Map(was).set(key, 'error'));
    }
  };

  /* A record's path, its root first, from what has been read: a loop in the data ends it rather than spinning. */
  const pathOf = (key: string, map: ReadonlyMap<string, TreeNode> = nodes): TreeNode[] => {
    const out: TreeNode[] = [];
    const seen = new Set<string>();
    for (let at = map.get(key); at && !seen.has(at.key) && out.length <= DEPTH; at = at.parent === null ? undefined : map.get(at.parent)) {
      seen.add(at.key);
      out.unshift(at);
    }
    return out;
  };
  /* The parents above these records that are not read yet, a level per request, bounded. */
  const climb = async (start: readonly TreeNode[]) => {
    const missing = (list: readonly TreeNode[]) => [
      ...new Set(list.flatMap((node) => (node.parent === null || known$.current.has(node.parent) ? [] : [node.parent]))),
    ];
    let wanted = missing(start);
    for (let step = 0; step < DEPTH && wanted.length; step++) {
      const rows = await rowsOf(`${from} ${by} in (${wanted.map(quoteValue).join(', ')}) ${shown}`, wanted.length);
      const found = rows.map(nodeOf).filter((node): node is TreeNode => node !== null);
      learn(found);
      wanted = missing(found);
    }
  };

  /* The chosen record, read by its key under the field's own filter, and its path above it. */
  const chosen = blank(value) ? undefined : String(value);
  useEffect(() => {
    if (value === undefined || value === '') return;
    let live = true;
    const have = known$.current.get(String(value));
    const read = have
      ? Promise.resolve(have)
      : rowsOf(`${from} ${andQuery(where, `${by} = ${quoteValue(value)}`)} ${shown}`, 1).then((rows) => {
          const node = nodeOf(rows[0]);
          if (node && live) learn([node]);
          return node;
        });
    void read.then((node) => (node && live ? climb([node]) : undefined)).catch(() => {});
    return () => {
      live = false;
    };
  }, [value, question]);

  const searching = typed && text.trim() !== '';
  useEffect(() => {
    const timer = setTimeout(() => setAsked(text.trim()), 150);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    if (!open || !searching || !asked) return;
    let live = true;
    const condition = `${labelColumn} contains ${JSON.stringify(asked)}`;
    rowsOf(`${from} ${andQuery(where, condition)} ${shown} sort ${labelColumn}`, MATCHES)
      .then(async (rows) => {
        const found = rows.map(nodeOf).filter((node): node is TreeNode => node !== null);
        learn(found);
        /* A path that cannot be read leaves the match said alone, not the search failed. */
        await climb(found).catch(() => {});
        if (live) setMatches({ for: asked, keys: found.map((node) => node.key) });
      })
      .catch(() => live && setMatches({ for: asked, error: true }));
    return () => {
      live = false;
    };
  }, [open, searching, asked, question]);

  /* Opened on the tree, it reads its tops and opens the way down to the chosen record, which is lit. */
  const revealed = useRef(false);
  useEffect(() => {
    if (!open || searching) {
      if (!open) revealed.current = false;
      return;
    }
    void level('');
    if (revealed.current || !chosen) return;
    const path = pathOf(chosen);
    if (!path.length || path[0].parent !== null) return;
    revealed.current = true;
    const above = path.slice(0, -1);
    setOpened((was) => new Set([...was, ...above.map((node) => node.key)]));
    for (const node of above) void level(node.key);
    setActive(chosen);
  }, [open, searching, chosen, nodes]);

  const branch = (key: string) => branches.get(key) !== false;
  const lines: Line[] = [];
  if (searching) {
    const answer = matches?.for === text.trim() ? matches : undefined;
    if (!answer) lines.push({ key: 'note:', depth: 1, note: say('loading') });
    else if ('error' in answer) lines.push({ key: 'note:', depth: 1, note: say('couldNotLoad') });
    else if (!answer.keys.length) lines.push({ key: 'note:', depth: 1, note: say('noMatches') });
    else
      for (const key of answer.keys) {
        const node = nodes.get(key);
        if (node)
          lines.push({
            key,
            depth: 1,
            node,
            path: pathOf(key)
              .slice(0, -1)
              .map((above) => above.label),
          });
      }
  } else {
    const walk = (key: string, depth: number, seen: ReadonlySet<string>) => {
      const here = kids.get(key);
      if (here === undefined || here === 'loading') return void lines.push({ key: `note:${key}`, depth, note: say('loading') });
      if (here === 'error') return void lines.push({ key: `note:${key}`, depth, note: say('couldNotLoad') });
      if (!here.length && key === '') lines.push({ key: 'note:', depth, note: say('nothingToChoose') });
      for (const child of here) {
        const node = nodes.get(child);
        if (!node || seen.has(child)) continue;
        lines.push({ key: child, depth, node });
        if (opened.has(child) && branch(child)) walk(child, depth + 1, new Set(seen).add(child));
      }
      if (cut.has(key)) lines.push({ key: `more:${key}`, depth, note: say('firstOnly', { count: formatNumber(LEVEL) }) });
    };
    if (open) walk('', 1, new Set());
  }
  const choosable = lines.filter((line) => line.node);
  const current = choosable.find((line) => line.key === active) ?? (searching ? choosable[0] : undefined);
  const lineId = (line: Line) => `${base}-${lines.indexOf(line)}`;
  useEffect(() => {
    if (open && current) shellById(lineId(current))?.scrollIntoView?.({ block: 'nearest' });
  }, [open, current?.key]);

  const expand = (key: string) => {
    setOpened((was) => new Set(was).add(key));
    void level(key);
  };
  const fold = (key: string) =>
    setOpened((was) => {
      const next = new Set(was);
      next.delete(key);
      return next;
    });
  const close = () => {
    setOpen(false);
    /* Left with a record still chosen, the box says its name again rather than the half-typed search. */
    if (chosen !== undefined) {
      setTyped(false);
      setText('');
    }
  };
  const pick = (node: TreeNode) => {
    onChange(node.value, node.label);
    setTyped(false);
    setText('');
    setActive(node.key);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const at = current ? choosable.indexOf(current) : -1;
    const light = (line: Line | undefined) => line && setActive(line.key);
    const tree = open && !searching && current?.node;
    const keys: Record<string, (() => void) | undefined> = {
      ArrowDown: () => (open ? light(choosable[Math.min(at + 1, choosable.length - 1)]) : setOpen(true)),
      ArrowUp: () => (open ? light(choosable[Math.max(at - 1, 0)]) : setOpen(true)),
      Home: open && !searching ? () => light(choosable[0]) : undefined,
      End: open && !searching ? () => light(choosable[choosable.length - 1]) : undefined,
      ArrowRight: tree
        ? () => {
            const key = current!.key;
            const below = kids.get(key);
            if (!opened.has(key)) {
              if (branch(key)) expand(key);
            } else if (Array.isArray(below) && below.length) setActive(below[0]);
          }
        : undefined,
      ArrowLeft: tree
        ? () => {
            const node = current!.node!;
            if (opened.has(node.key) && branch(node.key)) fold(node.key);
            else if (node.parent !== null && choosable.some((line) => line.key === node.parent)) setActive(node.parent);
          }
        : undefined,
      Enter: open && current?.node ? () => pick(current.node!) : undefined,
      Escape: open
        ? () => {
            event.stopPropagation();
            close();
          }
        : undefined,
    };
    const run = keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };

  /* The popup is as wide as the box, measured on the house ruler when it opens and again only when the box resizes:
     Base UI's own anchor width is recomputed as the rows arrive (Typeahead.tsx says why that loops). */
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open || !frame.current) return;
    const anchor = frame.current;
    setContainer(anchor.closest('dialog, [role="dialog"]') as HTMLElement | null);
    const measure = () => {
      const measured = viewportBox(anchor).width;
      setWidth(measured > 0 ? measured : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [open]);

  const box = typed ? text : chosen === undefined ? '' : (nodes.get(chosen)?.label ?? known ?? chosen);
  const trail = chosen === undefined || typed ? [] : pathOf(chosen);
  const said = trail.length > 1;
  return (
    <div className="tree-picker">
      <div className="picker" ref={frame}>
        <input
          ref={inputRef}
          id={id}
          className="picker-input"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-haspopup={searching ? 'listbox' : 'tree'}
          aria-autocomplete="list"
          aria-activedescendant={open && current ? lineId(current) : undefined}
          aria-describedby={[describedBy, said ? trailId : undefined].filter(Boolean).join(' ') || undefined}
          aria-invalid={invalid || undefined}
          required={required}
          disabled={disabled}
          placeholder={placeholder ?? say('choose')}
          autoComplete="off"
          value={box}
          onChange={(event) => {
            setText(event.target.value);
            setTyped(true);
            setActive(undefined);
            setOpen(true);
            if (chosen !== undefined) onChange('');
          }}
          onClick={() => !disabled && setOpen(true)}
          onBlur={close}
          onKeyDown={onKeyDown}
        />
        <Popover.Root open={open && !disabled} modal={false} onOpenChange={() => {}}>
          {/* Placed by Base UI against the box on the zoom-aware ruler, fixed to the viewport and drawn inside the
              enclosing dialog, so a modal's edge cannot clip it. Its own dismissal is not used: the box closes it on
              blur and Escape, and a row pressed keeps the focus in the box (a combobox's popup is never a stop). */}
          <Popover.Portal container={container ?? popupContainer()}>
            <Popover.Positioner
              anchor={() => (frame.current ? zoomAnchor(frame.current) : null)}
              positionMethod="fixed"
              side="bottom"
              align="start"
              sideOffset={4}
              collisionBoundary={layoutViewport()}
              collisionPadding={8}
              style={{ zIndex: 40, width: width === null ? 'var(--anchor-width)' : `${width}px`, maxWidth: 'var(--available-width)' }}
            >
              <Popover.Popup
                role="presentation"
                initialFocus={false}
                finalFocus={false}
                className="picker-popup tree-picker-popup"
                onMouseDown={(event) => event.preventDefault()}
              >
                <ul id={listId} role={searching ? 'listbox' : 'tree'} aria-label={ariaLabel ?? listLabel} className="picker-list">
                  {lines.map((line) => {
                    const node = line.node;
                    if (!node)
                      return (
                        <li key={line.key} role="presentation" className="picker-empty" style={{ paddingInlineStart: indent(line.depth) }}>
                          {line.note}
                        </li>
                      );
                    const lit = line === current;
                    const opens = !searching && branch(node.key);
                    return (
                      <li
                        key={line.key}
                        id={lineId(line)}
                        role={searching ? 'option' : 'treeitem'}
                        aria-level={searching ? undefined : line.depth}
                        aria-expanded={opens ? opened.has(node.key) : undefined}
                        aria-selected={lit}
                        className={`picker-option tree-picker-option${lit ? ' active' : ''}${node.key === chosen ? ' chosen' : ''}`}
                        style={searching ? undefined : { paddingInlineStart: indent(line.depth) }}
                        onClick={() => pick(node)}
                      >
                        {!searching && (
                          <span
                            className={`tree-picker-caret${opens ? '' : ' is-leaf'}`}
                            aria-hidden="true"
                            onClick={(event) => {
                              event.stopPropagation();
                              setActive(node.key);
                              if (!opens) return;
                              if (opened.has(node.key)) fold(node.key);
                              else expand(node.key);
                            }}
                          >
                            {opens && <Icon name={opened.has(node.key) ? 'caret-down' : 'caret-right'} size={12} />}
                          </span>
                        )}
                        <span className="picker-option-label">{node.label}</span>
                        {line.path && line.path.length > 0 && (
                          <span className="picker-option-detail tree-picker-path">{line.path.join(' › ')}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {said && (
        <p id={trailId} className="tree-picker-trail" aria-label={say('path')}>
          {trail.map((node, index) => (
            <Fragment key={node.key}>
              {index > 0 && (
                <span className="tree-picker-sep" aria-hidden="true">
                  ›
                </span>
              )}
              <span>{node.label}</span>
            </Fragment>
          ))}
        </p>
      )}
    </div>
  );
}

/* A level's inset: the caret column stands under its parent's name. */
const indent = (depth: number) => `calc(var(--space-2) + ${(depth - 1) * 18}px)`;
