/**
 * The schema drawn: one table and what it touches, or every table at once
 * ranked by dependency depth. Nodes list their columns and open to show
 * the rest; clicking a node walks there, so the diagram is navigation and
 * not just a picture. The geometry is `diagramModel.ts`; this draws it,
 * pans and zooms it, and exports it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { findTable, go, state, tableView, viewportBox, viewportScale } from '../core.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import {
  DENSE_SCHEMA,
  EDGE_LABEL_BUDGET,
  FIELD_H,
  HEAD_H,
  HUB_TABLES,
  NAME_BUDGET,
  NODE_PAD,
  NODE_W,
  PREVIEW_FIELDS,
  clip,
  neighbourhoodLayout,
  nodeHeight,
  orderedColumns,
  schemaLayout,
  shortType,
  type Fk,
  type Schema,
} from './diagramModel.js';
import { Picker } from './Picker.js';
import { SchemaExportControl } from './SchemaExport.js';
import { formatNumber } from '../locale.js';
import { say } from '../copy/workbench/components/Diagram.js';
import { addHostListener, portalRoot, removeHostListener } from '../shellHost.js';

/* Session state that a repaint must not forget: which nodes the reader has
   opened, which tables the overview is limited to, and whether they asked for
   the whole picture despite its density. */
const expanded = new Set<string>();
const focused = new Set<string>();
let showEverything = false;

const schemaOf = () => (state as { schema: Schema }).schema;
const heightOf = (id: string, preview = PREVIEW_FIELDS) => nodeHeight(findTable(id) as TableMeta | undefined, expanded.has(id), preview);

/* ---------- pieces ---------- */

function Node({
  tableId,
  x,
  y,
  role,
  preview = PREVIEW_FIELDS,
  repaint,
  extra,
}: {
  tableId: string;
  x: number;
  y: number;
  role: string;
  preview?: number;
  repaint: () => void;
  extra?: { className?: string; onMouseEnter?: () => void; onMouseLeave?: () => void };
}) {
  const table = findTable(tableId) as TableMeta | undefined;
  const height = heightOf(tableId, preview);
  const open = expanded.has(tableId);
  const ordered = table ? orderedColumns(table) : [];
  const shown = open ? ordered : ordered.slice(0, preview);
  const hidden = ordered.length - shown.length;
  const toggle = () => {
    if (open) expanded.delete(tableId);
    else expanded.add(tableId);
    repaint();
  };
  const walk = (mode: string) => go(tableView(tableId), mode);
  const label = tableId.length > 22 ? `${tableId.slice(0, 21)}…` : tableId;
  return (
    <g
      className={`node node-${role}${extra?.className ?? ''}`}
      data-table={tableId}
      onMouseEnter={extra?.onMouseEnter}
      onMouseLeave={extra?.onMouseLeave}
    >
      <rect x={x} y={y} width={NODE_W} height={height} rx={5} />
      <g
        className="node-head"
        role="button"
        tabIndex={0}
        onClick={() => walk(role === 'focus' ? 'replace' : 'reset')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            walk('reset');
          }
        }}
      >
        <rect x={x} y={y} width={NODE_W} height={HEAD_H} rx={5} className="node-head-hit" />
        <title>{table ? `${tableId} — ${say('columns', { count: table.columns.length })}` : tableId}</title>
        <text x={x + 10} y={y + HEAD_H / 2 + 4}>
          {label}
        </text>
      </g>
      {shown.length ? <line className="node-rule" x1={x} x2={x + NODE_W} y1={y + HEAD_H} y2={y + HEAD_H} /> : null}
      {shown.map((col, i) => {
        const cy = y + HEAD_H + NODE_PAD + i * FIELD_H + FIELD_H - 5;
        const mark = col.primaryKey ? '◆' : col.references ? '→' : '';
        return (
          <g key={col.name}>
            <text x={x + 10} y={cy} className={`node-field${col.primaryKey ? ' is-key' : ''}${col.references ? ' is-ref' : ''}`}>
              {`${mark ? `${mark} ` : ''}${clip(col.name, NAME_BUDGET)}`}
              {/* The full name and type stay reachable even when both are shortened. */}
              <title>{`${col.name} ${col.type ?? ''}`.trim()}</title>
            </text>
            <text x={x + NODE_W - 10} y={cy} className="node-type" textAnchor="end">
              {shortType(col.type)}
            </text>
          </g>
        );
      })}
      {/* The toggle only exists when there is something behind it. */}
      {hidden > 0 || open
        ? (() => {
            const cy = y + HEAD_H + NODE_PAD + shown.length * FIELD_H + FIELD_H - 5;
            return (
              <g
                className="node-more"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  toggle();
                }}
              >
                <rect x={x} y={cy - FIELD_H + 4} width={NODE_W} height={FIELD_H} className="node-more-hit" />
                <text x={x + 10} y={cy}>
                  {open ? say('showLess') : shown.length ? say('plusMore', { count: hidden }) : say('plusColumns', { count: hidden })}
                </text>
              </g>
            );
          })()
        : null}
    </g>
  );
}

function Edge({ x1, y1, x2, y2, label, marker }: { x1: number; y1: number; x2: number; y2: number; label?: string; marker: string }) {
  const mid = (x1 + x2) / 2;
  return (
    <g>
      <path className="edge" markerEnd={`url(#${marker})`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} />
      {label ? (
        <text x={mid} y={y1 - 6} className="edge-label" textAnchor="middle">
          {label.length > EDGE_LABEL_BUDGET ? `${label.slice(0, EDGE_LABEL_BUDGET - 1)}…` : label}
          <title>{label}</title>
        </text>
      ) : null}
    </g>
  );
}

const Arrow = ({ id, size }: { id: string; size: number }) => (
  <defs>
    <marker id={id} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={size} markerHeight={size} orient="auto-start-reverse">
      <path d="M0,0 L8,4 L0,8 z" className="edge-head" />
    </marker>
  </defs>
);

/**
 * Pan and zoom, imperative on purpose: the transform changes on every wheel
 * tick and pointer move, and a state update per pixel would be a render per
 * pixel. Opens fitted when fitting is readable, centred on the focus
 * otherwise; wheel zooms about the pointer; dragging the background pans.
 */
function PanZoom({
  size,
  focus,
  expand,
  svgRef,
  label,
  svgClassName,
  children,
}: {
  size: { width: number; height: number };
  focus?: { x: number; y: number };
  expand?: () => void;
  svgRef: React.RefObject<SVGSVGElement | null>;
  label: string;
  svgClassName?: string;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<SVGGElement>(null);
  const [readout, setReadout] = useState('100%');
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const MIN = 0.15;
  const MAX = 3;
  const apply = () => {
    const { x, y, scale } = view.current;
    content.current?.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
    setReadout(`${Math.round(scale * 100)}%`);
  };
  const zoomAt = (factor: number, px: number, py: number) => {
    const v = view.current;
    const next = Math.min(MAX, Math.max(MIN, v.scale * factor));
    if (next === v.scale) return;
    v.x = px - ((px - v.x) * next) / v.scale;
    v.y = py - ((py - v.y) * next) / v.scale;
    v.scale = next;
    apply();
  };
  /* Never enlarges: fitting is about getting the whole thing on screen. Centred on both axes. */
  const fit = () => {
    const box = viewportBox(viewport.current!);
    if (!box.width) return false;
    const v = view.current;
    v.scale = Math.min(1, Math.max(MIN, Math.min((box.width - 24) / size.width, (box.height - 24) / size.height)));
    v.x = (box.width - size.width * v.scale) / 2;
    v.y = (box.height - size.height * v.scale) / 2;
    apply();
    return true;
  };
  const reset = () => {
    const box = viewportBox(viewport.current!);
    const v = view.current;
    v.scale = 1;
    v.x = Math.min(12, (box.width - size.width) / 2);
    v.y = Math.min(12, (box.height - size.height) / 2);
    apply();
  };
  useLayoutEffect(() => {
    const node = viewport.current!;
    const READABLE = 0.5;
    const open = () => {
      const box = viewportBox(node);
      if (!box.width) return false;
      const fitted = Math.min((box.width - 24) / size.width, (box.height - 24) / size.height);
      if (!focus || fitted >= READABLE) return fit();
      view.current = { scale: 1, x: box.width / 2 - focus.x, y: box.height / 2 - focus.y };
      apply();
      return true;
    };
    /* Opening needs a measured viewport, which does not exist until the node is laid out. */
    let watch: ResizeObserver | null = null;
    if (!open() && typeof ResizeObserver !== 'undefined') {
      watch = new ResizeObserver(() => {
        if (open()) watch?.disconnect();
      });
      watch.observe(node);
    }
    /* Wheel zooms rather than scrolls; shift pans sideways. Non-passive, so the page does not scroll too. */
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const z = viewportScale() as number;
      const box = viewportBox(node);
      const px = e.clientX / z - box.left;
      const py = e.clientY / z - box.top;
      if (e.shiftKey && !e.ctrlKey) {
        view.current.x -= (e.deltaY || e.deltaX) / z;
        apply();
        return;
      }
      zoomAt(Math.exp(-e.deltaY / 400), px, py);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      watch?.disconnect();
      node.removeEventListener('wheel', onWheel);
    };
  }, [size.width, size.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const dragging = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const centre = () => {
    const b = viewportBox(viewport.current!);
    return [b.width / 2, b.height / 2] as const;
  };
  return (
    <div
      ref={viewport}
      className="diagram-viewport"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        /* The controls sit inside the viewport; a press on one must not start a pan. */
        if ((e.target as Element).closest('.node-head, .node-more, .zoom-controls')) return;
        dragging.current = { px: e.clientX, py: e.clientY, x: view.current.x, y: view.current.y };
        viewport.current!.setPointerCapture(e.pointerId);
        viewport.current!.classList.add('dragging');
      }}
      onPointerMove={(e) => {
        const d = dragging.current;
        if (!d) return;
        const z = viewportScale() as number;
        view.current.x = d.x + (e.clientX - d.px) / z;
        view.current.y = d.y + (e.clientY - d.py) / z;
        apply();
      }}
      onPointerUp={() => {
        dragging.current = null;
        viewport.current?.classList.remove('dragging');
      }}
      onPointerCancel={() => {
        dragging.current = null;
        viewport.current?.classList.remove('dragging');
      }}
    >
      {/* No viewBox: the group's transform is the camera, so it fills its box and the numbers stay layout pixels. */}
      {/* A group, not an image: its tables are Tab stops, and an image's
          children are hidden from assistive technology, focusable or not. */}
      <svg
        ref={svgRef}
        role="group"
        aria-roledescription={say('diagram')}
        style={{ width: '100%', height: '100%' }}
        aria-label={label}
        className={svgClassName}
      >
        <g ref={content}>{children}</g>
      </svg>
      <div className="zoom-controls">
        <button
          type="button"
          className="ghost"
          title={say('zoomOut')}
          aria-label={say('zoomOut')}
          onClick={() => {
            const [cx, cy] = centre();
            zoomAt(1 / 1.25, cx, cy);
          }}
        >
          −
        </button>
        <span className="zoom-readout">{readout}</span>
        <button
          type="button"
          className="ghost"
          title={say('zoom')}
          aria-label={say('zoom')}
          onClick={() => {
            const [cx, cy] = centre();
            zoomAt(1.25, cx, cy);
          }}
        >
          +
        </button>
        <button type="button" className="ghost" title={say('fitTheWholeDiagram')} onClick={fit}>
          {say('fit')}
        </button>
        <button type="button" className="ghost" title={say('actualSize')} onClick={reset}>
          1:1
        </button>
        {expand ? (
          <button type="button" className="ghost" title={say('fullScreen')} aria-label={say('openTheDiagramFull')} onClick={expand}>
            ⛶
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The same diagram over everything, with Escape captured so the page's own habits do not fire underneath. */
function Fullscreen({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="diagram-full">
      <button type="button" className="ghost diagram-full-close" aria-label={say('closeTheFullScreen')} onClick={onClose}>
        {say('closeEsc')}
      </button>
      {children}
    </div>,
    portalRoot(),
  );
}

/* ---------- one table and its neighbours ---------- */

export function NeighbourhoodDiagram({ tableId, expandable = true }: { tableId: string; expandable?: boolean }) {
  const [, bump] = useState(0);
  const repaint = () => bump((n) => n + 1);
  const [full, setFull] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const focus = findTable(tableId) as TableMeta | undefined;
  if (!focus) return <p className="note">{say('unknownTable')}</p>;
  const layout = neighbourhoodLayout(schemaOf(), tableId, (id) => heightOf(id));
  if (!layout) return <p className="note">{say('hasNoForeignKeys', { tableId })}</p>;
  const { left, right, self, width, height, leftX, midX, rightX, focusTop, focusAnchor, drawn } = layout;
  const drawing = (
    <>
      <Arrow id="arrow" size={7} />
      {left.map((node) => (
        <g key={node.table}>
          <Edge x1={leftX + NODE_W} y1={node.top + HEAD_H / 2} x2={midX} y2={focusAnchor} label={node.columns.join(' · ')} marker="arrow" />
          <Node tableId={node.table} x={leftX} y={node.top} role="out" repaint={repaint} />
        </g>
      ))}
      {right.map((node) => (
        <g key={node.table}>
          <Edge
            x1={rightX}
            y1={node.top + HEAD_H / 2}
            x2={midX + NODE_W}
            y2={focusAnchor}
            label={node.columns.join(' · ')}
            marker="arrow"
          />
          <Node tableId={node.table} x={rightX} y={node.top} role="in" repaint={repaint} />
        </g>
      ))}
      {self.length ? (
        /* A self-reference has nowhere else to go, so it loops above the node. */
        <>
          <path
            className="edge"
            markerEnd="url(#arrow)"
            d={`M${midX + NODE_W * 0.3},${focusTop} C${midX + NODE_W * 0.1},${focusTop - 34} ${midX + NODE_W * 0.9},${focusTop - 34} ${midX + NODE_W * 0.7},${focusTop}`}
          />
          <text x={midX + NODE_W / 2} y={focusTop - 22} className="edge-label" textAnchor="middle">
            {self.map((fk) => fk.from.columns.join(', ')).join(' · ')}
          </text>
        </>
      ) : null}
      <Node tableId={tableId} x={midX} y={focusTop} role="focus" repaint={repaint} />
    </>
  );
  return (
    <>
      <div className="diagram-head">
        <h2 className="diagram-title">{say('andWhatItTouches', { name: focus.name })}</h2>
        <SchemaExportControl
          schema={schemaOf()}
          only={drawn}
          picture={() => ({ svg: svg.current ?? undefined, size: { width, height } })}
        />
      </div>
      <PanZoom
        size={{ width, height }}
        focus={{ x: midX + NODE_W / 2, y: focusAnchor }}
        svgRef={svg}
        label={say('foreignKeyNeighbourhood', { tableId })}
        expand={expandable ? () => setFull(true) : undefined}
      >
        {drawing}
      </PanZoom>
      <p className="diagram-legend">
        <span className="legend-out">{say('points')}</span>
        <span>{`  ${focus.name}  `}</span>
        <span className="legend-in">{say('pointed')}</span>
      </p>
      {/* The overlay's own instance offers no second overlay. */}
      {full ? (
        <Fullscreen onClose={() => setFull(false)}>
          <div className="diagram">
            <NeighbourhoodDiagram tableId={tableId} expandable={false} />
          </div>
        </Fullscreen>
      ) : null}
    </>
  );
}

/* ---------- the whole schema ---------- */

export function SchemaDiagram({ expandable = true }: { expandable?: boolean }) {
  const [, bump] = useState(0);
  const repaint = () => bump((n) => n + 1);
  const [full, setFull] = useState(false);
  const [lit, setLit] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const schema = schemaOf();
  const layout = schemaLayout(schema, focused, showEverything, (table, preview) => nodeHeight(table, expanded.has(table.id), preview));
  if (!layout) return <p className="note">{say('thisDatabaseHasNoTables')}</p>;
  const { tables, foreignKeys, pos, width, height, levels, preview, trimmed } = layout;
  const allTables = schema.tables;
  const visible = new Set(tables.map((t) => t.id));
  /* Hovering a table dims everything it is not connected to: on a hundred tables, the difference between a picture and an answer. */
  const connected = new Set<string>();
  if (lit) {
    connected.add(lit);
    for (const fk of schema.foreignKeys) {
      if (fk.from.table === lit) connected.add(fk.to.table);
      if (fk.to.table === lit) connected.add(fk.from.table);
    }
  }
  const orphans = tables.filter((t) => !foreignKeys.some((fk) => fk.from.table === t.id || fk.to.table === t.id));
  const edgeOf = (fk: Fk, i: number) => {
    const from = pos.get(fk.from.table);
    const to = pos.get(fk.to.table);
    if (!from || !to) return null;
    const dim = Boolean(lit) && fk.from.table !== lit && fk.to.table !== lit;
    if (fk.from.table === fk.to.table) {
      const x = from.x + NODE_W / 2;
      const y = from.top;
      return (
        <path
          key={i}
          className={`edge${dim ? ' dim' : ''}`}
          markerEnd="url(#arrow-s)"
          d={`M${x - 18},${y} C${x - 24},${y - 22} ${x + 24},${y - 22} ${x + 18},${y}`}
          data-from={fk.from.table}
          data-to={fk.to.table}
        />
      );
    }
    /* Leaving from whichever side faces the target keeps lines from doubling back across their own node. */
    const leftToRight = to.x >= from.x;
    const x1 = leftToRight ? from.x + NODE_W : from.x;
    const x2 = leftToRight ? to.x : to.x + NODE_W;
    const mid = (x1 + x2) / 2;
    return (
      <path
        key={i}
        className={`edge${dim ? ' dim' : ''}`}
        markerEnd="url(#arrow-s)"
        d={`M${x1},${from.y} C${mid},${from.y} ${mid},${to.y} ${x2},${to.y}`}
        data-from={fk.from.table}
        data-to={fk.to.table}
      />
    );
  };
  const drawing = (
    <>
      <Arrow id="arrow-s" size={6} />
      <g className="schema-edges">{foreignKeys.map(edgeOf)}</g>
      {tables.map((table) => {
        const p = pos.get(table.id)!;
        const className = lit ? (table.id === lit ? ' lit' : connected.has(table.id) ? '' : ' dim') : '';
        return (
          <Node
            key={table.id}
            tableId={table.id}
            x={p.x}
            y={p.top}
            role={table.isView ? 'view' : 'out'}
            preview={preview}
            repaint={repaint}
            extra={{ className, onMouseEnter: () => setLit(table.id), onMouseLeave: () => setLit(null) }}
          />
        );
      })}
    </>
  );
  return (
    <>
      <div className="diagram-head">
        <h2 className="diagram-title">{schema.label}</h2>
        <div className="diagram-focus">
          {[...focused].map((id) => {
            const table = allTables.find((t) => t.id === id);
            return (
              <button
                key={id}
                type="button"
                className="diagram-chip"
                title={say('stopLimiting', { name: table?.name ?? id })}
                onClick={() => {
                  focused.delete(id);
                  repaint();
                }}
              >
                <span>{table?.name ?? id}</span>
                <span className="chip-x" aria-hidden="true">
                  ×
                </span>
              </button>
            );
          })}
          {focused.size ? (
            <button
              type="button"
              className="ghost diagram-clear"
              onClick={() => {
                focused.clear();
                repaint();
              }}
            >
              {say('showAll')}
            </button>
          ) : null}
          <Picker
            items={allTables
              .filter((t) => !focused.has(t.id))
              .map((t) => ({ value: t.id, label: t.name, detail: say('cols', { count: t.columns.length }) }))}
            onPick={(id) => {
              if (allTables.some((t) => t.id === id)) {
                focused.add(id);
                repaint();
              }
            }}
            ariaLabel={say('limitTheDiagramToThese')}
            placeholder={focused.size ? say('addAnotherTable') : say('showOnly')}
          />
        </div>
        {/* `visible`, not `focused`: the diagram draws one hop past the chips, and the export should hold what is on screen. */}
        <SchemaExportControl
          schema={schema}
          only={focused.size || trimmed ? visible : undefined}
          picture={() => ({ svg: svg.current ?? undefined, size: { width, height } })}
        />
      </div>
      <PanZoom
        size={{ width, height }}
        svgRef={svg}
        label={say('entityDiagram', { label: schema.label ?? '' })}
        svgClassName={lit ? 'has-focus' : undefined}
        expand={expandable ? () => setFull(true) : undefined}
      >
        {drawing}
      </PanZoom>
      <p className="diagram-legend">
        <span>
          {trimmed
            ? say('mostConnectedOf', {
                shown: formatNumber(tables.length),
                tables: say('tables', { count: allTables.length }),
                keys: say('foreignKeys', { count: foreignKeys.length }),
              })
            : focused.size
              ? say('focusedOf', {
                  shown: formatNumber(tables.length),
                  tables: say('tables', { count: allTables.length }),
                  keys: say('foreignKeys', { count: foreignKeys.length }),
                })
              : `${say('tables', { count: tables.length })} · ${say('foreignKeys', { count: foreignKeys.length })} · `}
        </span>
        <span>{say('levelsDeepLeftToRight', { count: levels })}</span>
        {trimmed ? (
          <button
            type="button"
            className="ghost diagram-scope"
            onClick={() => {
              showEverything = true;
              repaint();
            }}
          >
            {say('showAllTables', { count: allTables.length })}
          </button>
        ) : null}
        {!trimmed && !focused.size && showEverything && allTables.length > DENSE_SCHEMA ? (
          <button
            type="button"
            className="ghost diagram-scope"
            onClick={() => {
              showEverything = false;
              repaint();
            }}
          >
            {say('showTheHubs', { count: Math.min(HUB_TABLES, allTables.length) })}
          </button>
        ) : null}
      </p>
      {orphans.length ? (
        <p className="diagram-legend">{`${say('tablesWithNoForeignKeys', {
          count: orphans.length,
          names: orphans
            .slice(0, 6)
            .map((t) => t.name)
            .join(', '),
        })}${orphans.length > 6 ? '…' : ''}`}</p>
      ) : null}
      {full ? (
        <Fullscreen onClose={() => setFull(false)}>
          <div className="diagram diagram-schema">
            <SchemaDiagram expandable={false} />
          </div>
        </Fullscreen>
      ) : null}
    </>
  );
}
