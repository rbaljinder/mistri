/** Dependency-linked Gantt schedule and trace waterfall timeline built on UI SDK spans behavior. */
import { Icon } from '../Icon.js';
import { Avatar, AvatarFallback } from '@ui-sdk/react/avatar';
import { Button } from '@ui-sdk/react/button';
import {
  Waterfall,
  WaterfallAxis,
  WaterfallBar,
  WaterfallCell,
  WaterfallColumnHeader,
  WaterfallHeaderRow,
  WaterfallIndicator,
  WaterfallMark,
  WaterfallRow,
  WaterfallRowHeader,
  WaterfallTick,
} from '@ui-sdk/react/waterfall';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { type Span, Spans, SpansAxis, SpansNow, SpansRegion, SpansSpan, SpansTrack } from '@mistriwork/ui/behaviors/index.js';
import { cx, toDataTone, type EmptyStateSpec, type Tone } from '../internal/cx.js';
import { resolveLocale } from '../internal/locale.js';
import { labelEvery, useElementWidth } from './axisLabels.js';

/* ========================================================================== */
/* 1. GanttView (Built on Spans axis="x" stay)                                */
/* ========================================================================== */

/** Scheduled task bar descriptor in `GanttView`. */
export interface GanttTask {
  id: string;
  code?: string;
  name: string;
  owner?: string;
  ownerInitials?: string;
  status?: string;
  tone?: Tone;
  /** Start unit along timeline (e.g. day index from 0) */
  start: number;
  /** End unit along timeline (e.g. day index) */
  end: number;
  /** Completion percentage 0..100 */
  progress?: number;
  milestone?: boolean;
  locked?: boolean;
}

/** Highlighted or blocked timeline interval in `GanttView`. */
export interface GanttRegion {
  id?: string;
  from: number;
  to: number;
  label?: string;
  track?: string;
}

/** Props for the `GanttView` schedule roadmap component. */
export interface GanttViewProps {
  tasks: GanttTask[];
  onTasksChange?: (tasks: GanttTask[]) => void;
  onTaskClick?: (task: GanttTask) => void;
  /** Timeline start unit (default: 0) */
  min?: number;
  /** Timeline end unit (default: auto or 28) */
  max?: number;
  /** Drag/keyboard snap unit (default: 1) */
  step?: number;
  /** Header tick step (default: 2) */
  axisStep?: number;
  /** Present vertical line position (e.g. current day offset) */
  now?: number | (() => number);
  /** Blocked/weekend/freeze regions rendered via SpansRegion */
  regions?: GanttRegion[];
  /** Optional anchor calendar date (ISO YYYY-MM-DD or Date) for formatting day offsets as dates */
  startDate?: string | Date;
  locale?: string;
  /** Custom formatter for timeline header ticks (e.g. Day 1 -> "Nov 14") */
  formatTick?: (unit: number) => string;
  /** Custom formatter for task bar range readout */
  formatRange?: (start: number, end: number) => string;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  className?: string;
}

function initialsFromName(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

function parseAnchorUtcMs(startDate: string | Date | undefined): number | null {
  if (!startDate) return null;
  if (startDate instanceof Date) {
    return Number.isNaN(startDate.getTime()) ? null : startDate.getTime();
  }
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate.trim());
  if (isoMatch) {
    return Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }
  const parsed = Date.parse(startDate);
  return Number.isNaN(parsed) ? null : parsed;
}

function defaultTickLabel(unit: number): string {
  if (!Number.isFinite(unit)) return '';
  if (Number.isInteger(unit) && unit >= 0) {
    return `Day ${unit + 1}`;
  }
  const formatted = Number.isInteger(unit) ? String(unit) : unit.toFixed(1).replace(/\.0$/, '');
  return `${unit >= 0 ? '+' : ''}${formatted}d`;
}

/** Interactive Gantt schedule pairing a task metadata sheet with draggable timeline bars. */
export function GanttView({
  tasks: propTasks,
  onTasksChange,
  onTaskClick,
  min = 0,
  max: explicitMax,
  step = 1,
  axisStep = 2,
  now,
  regions = [],
  startDate,
  locale,
  formatTick: explicitFormatTick,
  formatRange,
  ariaLabel = 'Project Gantt roadmap',
  className,
}: GanttViewProps) {
  const formatTick = useMemo(() => {
    if (explicitFormatTick) return explicitFormatTick;
    const anchorMs = parseAnchorUtcMs(startDate);
    if (anchorMs === null) return defaultTickLabel;
    const formatter = new Intl.DateTimeFormat(resolveLocale(locale), {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return (unit: number) => formatter.format(new Date(anchorMs + unit * 86_400_000));
  }, [explicitFormatTick, startDate, locale]);

  const [localTasks, setLocalTasks] = useState<GanttTask[] | null>(null);
  const tasks = onTasksChange ? propTasks : (localTasks ?? propTasks);

  const computedMax = useMemo(() => {
    if (explicitMax !== undefined) return explicitMax;
    const highest = tasks.reduce((acc, t) => Math.max(acc, t.end), 14);
    return Math.max(14, Math.ceil((highest + 2) / 2) * 2);
  }, [explicitMax, tasks]);

  const tasksById = useMemo(() => {
    const map = new Map<string, GanttTask>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  const spansValue = useMemo<Span[]>(
    () =>
      tasks.map((t) => ({
        id: t.id,
        track: t.id,
        start: t.start,
        end: Math.max(t.start + step, t.end),
      })),
    [tasks, step],
  );

  /* The ruler is labelled at every `axisStep`, thinned to what its width holds: the labels are placed by percentage,
     so in a narrow card every one of them was printed over its neighbour. */
  const rulerRef = useRef<HTMLDivElement>(null);
  const rulerWidth = useElementWidth(rulerRef);
  const rulerEvery = useMemo(() => {
    if (!(axisStep > 0)) return 1;
    let count = 0;
    let widest = 1;
    for (let unit = min; unit <= computedMax; unit += axisStep) {
      count += 1;
      widest = Math.max(widest, formatTick(unit).length);
    }
    return labelEvery(count, widest, rulerWidth);
  }, [axisStep, min, computedMax, formatTick, rulerWidth]);

  const handleSpansChange = (nextSpans: Span[]) => {
    const spanMap = new Map(nextSpans.map((s) => [s.id, s]));
    const updated = tasks.map((task) => {
      const s = spanMap.get(task.id);
      if (!s) return task;
      return {
        ...task,
        start: s.start,
        end: s.end,
      };
    });
    if (!onTasksChange) setLocalTasks(updated);
    onTasksChange?.(updated);
  };

  return (
    /* Past its height the view scrolls its own rows, on purpose, and says so for the check that looks for a page
       scrolling twice (gradeProbe.ts). */
    <div className={cx('nx-gantt', className)} role="region" aria-label={ariaLabel} data-scrolls="">
      {/* Left Fixed Task Sheet */}
      <div className="nx-gantt-sheet">
        <div className="nx-gantt-sheet-head">
          <span className="nx-gantt-col-task">Task</span>
          <span className="nx-gantt-col-owner">Owner</span>
          <span className="nx-gantt-col-status">Status</span>
        </div>

        <div className="nx-gantt-sheet-body">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="nx-gantt-sheet-row"
              data-clickable={onTaskClick ? '' : undefined}
              onClick={() => onTaskClick?.(task)}
            >
              <div className="nx-gantt-col-task">
                {task.milestone && <Icon name="diamond" size={12} weight="bold" className="nx-gantt-milestone-icon" />}
                {task.code && <span className="nx-gantt-task-code">{task.code}</span>}
                <span className="nx-gantt-task-name" title={task.name}>
                  {task.name}
                </span>
                {task.locked && <Icon name="lock" size={12} className="nx-gantt-lock-icon" label="Locked" />}
              </div>

              <div className="nx-gantt-col-owner">
                {task.owner ? (
                  <span className="nx-gantt-owner-chip" title={task.owner}>
                    <Avatar className="nx-gantt-avatar">
                      <AvatarFallback className="nx-gantt-avatar-fallback">
                        {task.ownerInitials ?? initialsFromName(task.owner)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="nx-gantt-owner-name">{task.owner}</span>
                  </span>
                ) : (
                  <span className="nx-gantt-muted">—</span>
                )}
              </div>

              <div className="nx-gantt-col-status">
                {task.status ? (
                  <span className="nx-status-dot" data-tone={toDataTone(task.tone) ?? 'neutral'}>
                    {task.status}
                  </span>
                ) : (
                  <span className="nx-gantt-muted">—</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Interactive Timeline built on Spans */}
      <div className="nx-gantt-timeline-scroll">
        <Spans
          axis="x"
          min={min}
          max={computedMax}
          step={step}
          minSize={step}
          stay
          value={spansValue}
          onValueChange={handleSpansChange}
          locked={(span) => Boolean(tasksById.get(span.id)?.locked)}
          label={(span) => {
            const task = tasksById.get(span.id);
            const rangeText = formatRange ? formatRange(span.start, span.end) : `${formatTick(span.start)} to ${formatTick(span.end)}`;
            return `${task?.name ?? span.id}, ${rangeText}`;
          }}
          onPick={(id) => {
            const task = tasksById.get(id);
            if (task) onTaskClick?.(task);
          }}
          className="nx-gantt-spans"
        >
          {/* Header Ruler */}
          <div className="nx-gantt-ruler" ref={rulerRef}>
            <SpansAxis step={axisStep} lines={false} format={formatTick} every={rulerEvery} />
          </div>

          {/* Tracks Stage */}
          <div className="nx-gantt-tracks-stage">
            <SpansAxis step={step} labels={false} />

            {regions.map((region, idx) => (
              <SpansRegion
                key={region.id ?? `${region.from}-${region.to}-${idx}`}
                from={region.from}
                to={region.to}
                track={region.track}
                className="nx-gantt-region"
              >
                {region.label}
              </SpansRegion>
            ))}

            {now !== undefined && <SpansNow value={now} className="nx-gantt-now" />}

            {tasks.map((task) => (
              <SpansTrack key={task.id} value={task.id} className="nx-gantt-track">
                {(onTrack) =>
                  onTrack.map((bar) => {
                    const pct = Math.max(0, Math.min(100, task.progress ?? 0));
                    const dur = bar.end - bar.start;
                    return (
                      <SpansSpan
                        key={bar.id}
                        value={bar.id}
                        data-tone={toDataTone(task.tone) ?? 'accent'}
                        aria-label={`${task.name}: ${formatTick(bar.start)} – ${formatTick(bar.end)}`}
                        className="nx-gantt-bar"
                      >
                        {!task.locked && <i data-span-edge="start" className="nx-gantt-edge" data-edge="start" />}
                        {pct > 0 && <span className="nx-gantt-bar-progress" style={{ width: `${pct}%` }} aria-hidden="true" />}
                        <span className="nx-gantt-bar-content">
                          <span className="nx-gantt-bar-label">{task.name}</span>
                          <span className="nx-gantt-bar-meta">{formatRange ? formatRange(bar.start, bar.end) : `${dur}d`}</span>
                        </span>
                        {!task.locked && <i data-span-edge="end" className="nx-gantt-edge" data-edge="end" />}
                      </SpansSpan>
                    );
                  })
                }
              </SpansTrack>
            ))}
          </div>
        </Spans>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* 2. WaterfallView (Built on @ui-sdk/react/waterfall)                        */
/* ========================================================================== */

/** Hierarchical execution trace span item in `WaterfallView`. */
export interface WaterfallSpanItem {
  value: string;
  label: string;
  start: number;
  duration: number;
  service?: string;
  tone?: Tone;
  statusText?: string;
  children?: WaterfallSpanItem[];
}

/** Vertical timestamp marker line in `WaterfallView`. */
export interface WaterfallMarker {
  time: number;
  label?: string;
}

/** Props for the `WaterfallView` execution trace component. */
export interface WaterfallViewProps {
  items: WaterfallSpanItem[];
  range?: [number, number];
  marks?: WaterfallMarker[];
  value?: string | null;
  defaultValue?: string | null;
  onSelectSpan?: (span: WaterfallSpanItem | null, id: string | null) => void;
  expanded?: string[];
  defaultExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
  title?: string;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  className?: string;
}

function collectSpansPreOrder(nodes: readonly WaterfallSpanItem[], acc: WaterfallSpanItem[] = []): WaterfallSpanItem[] {
  for (const node of nodes) {
    acc.push(node);
    if (node.children && node.children.length > 0) {
      collectSpansPreOrder(node.children, acc);
    }
  }
  return acc;
}

function formatDurationMs(ms: number): string {
  // Nothing is not a count of microseconds: the axis's origin read "0µs" beside "50ms".
  if (ms === 0) return '0ms';
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 1000) return `${ms % 1 === 0 ? ms : ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Hierarchical distributed trace and request waterfall timeline with span inspector. */
export function WaterfallView({
  items,
  range,
  marks = [],
  value: controlledValue,
  defaultValue = null,
  onSelectSpan,
  expanded: controlledExpanded,
  defaultExpanded,
  onExpandedChange,
  title = 'Execution trace',
  ariaLabel = 'Execution waterfall timeline',
  className,
}: WaterfallViewProps) {
  const flatItems = useMemo(() => collectSpansPreOrder(items), [items]);
  const branchIds = useMemo(() => flatItems.filter((i) => i.children && i.children.length > 0).map((i) => i.value), [flatItems]);

  const [internalExpanded, setInternalExpanded] = useState<string[]>(() => defaultExpanded ?? branchIds);
  const [internalValue, setInternalValue] = useState<string | null>(defaultValue);

  const expanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
  const selectedId = controlledValue !== undefined ? controlledValue : internalValue;

  const itemMap = useMemo(() => {
    const m = new Map<string, WaterfallSpanItem>();
    for (const item of flatItems) m.set(item.value, item);
    return m;
  }, [flatItems]);

  const setExpanded = (next: string[]) => {
    if (controlledExpanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  };

  const handleSelect = (nextVal: string | null) => {
    if (controlledValue === undefined) setInternalValue(nextVal);
    onSelectSpan?.(nextVal ? (itemMap.get(nextVal) ?? null) : null, nextVal);
  };

  const selectedSpan = selectedId ? itemMap.get(selectedId) : undefined;

  /* The axis is labelled at as many of its ticks as the timeline column holds: six "120ms" labels in a 140px
     column were one unreadable strip. */
  const axisRef = useRef<HTMLDivElement>(null);
  const axisWidth = useElementWidth(axisRef);

  return (
    <div className={cx('nx-waterfall-wrap', className)}>
      <div className="nx-waterfall-toolbar">
        <div className="nx-waterfall-toolbar-title">
          <span>{title}</span>
          <span className="nx-badge" data-pill="">
            {flatItems.length} spans
          </span>
        </div>

        {branchIds.length > 0 && (
          <div className="nx-waterfall-toolbar-actions">
            <Button data-size="xs" data-variant="ghost" onClick={() => setExpanded(branchIds)}>
              <Icon name="arrows-out-line-vertical" size={12} />
              <span>Expand all</span>
            </Button>
            <Button data-size="xs" data-variant="ghost" onClick={() => setExpanded([])}>
              <Icon name="arrows-in-line-vertical" size={12} />
              <span>Collapse all</span>
            </Button>
          </div>
        )}
      </div>

      <Waterfall
        items={items}
        range={range}
        value={selectedId}
        onValueChange={handleSelect}
        expanded={expanded}
        onExpandedChange={setExpanded}
        aria-label={ariaLabel}
        className="nx-waterfall"
      >
        <WaterfallHeaderRow className="nx-waterfall-header-row">
          <WaterfallColumnHeader className="nx-waterfall-col-name">Operation</WaterfallColumnHeader>
          <WaterfallColumnHeader className="nx-waterfall-col-dur">Duration</WaterfallColumnHeader>
          <WaterfallColumnHeader className="nx-waterfall-col-timeline">
            <WaterfallAxis ref={axisRef} maxTicks={6} className="nx-waterfall-axis">
              {(axisState) => {
                const labels = axisState.ticks.map((tick) => formatDurationMs(tick.time));
                const widest = labels.reduce((acc, label) => Math.max(acc, label.length), 1);
                const every = labelEvery(labels.length, widest, axisWidth);
                return axisState.ticks.map((tick, at) =>
                  at % every === 0 ? (
                    <WaterfallTick key={tick.time} time={tick.time} className="nx-waterfall-tick">
                      {labels[at]}
                    </WaterfallTick>
                  ) : null,
                );
              }}
            </WaterfallAxis>
          </WaterfallColumnHeader>
        </WaterfallHeaderRow>

        <div className="nx-waterfall-body">
          {marks.length > 0 && (
            <div className="nx-waterfall-marks-layer" aria-hidden="true">
              {marks.map((mk) => (
                <WaterfallMark
                  key={mk.time}
                  time={mk.time}
                  className="nx-waterfall-mark"
                  title={mk.label ? `${mk.label} (${formatDurationMs(mk.time)})` : undefined}
                />
              ))}
            </div>
          )}

          {flatItems.map((span) => {
            const isBranch = Boolean(span.children && span.children.length > 0);
            return (
              <WaterfallRow key={span.value} value={span.value} className="nx-waterfall-row">
                <WaterfallRowHeader className="nx-waterfall-name-cell">
                  {isBranch ? (
                    <WaterfallIndicator className="nx-waterfall-ind">
                      <Icon name="caret-right" size={11} weight="bold" />
                    </WaterfallIndicator>
                  ) : (
                    <span className="nx-waterfall-leaf-spacer" aria-hidden="true" />
                  )}
                  {span.service && (
                    <span className="nx-badge" data-tone={toDataTone(span.tone)}>
                      {span.service}
                    </span>
                  )}
                  <span className="nx-waterfall-span-label" title={span.label}>
                    {span.label}
                  </span>
                </WaterfallRowHeader>

                <WaterfallCell className="nx-waterfall-dur-cell">{formatDurationMs(span.duration)}</WaterfallCell>

                <WaterfallBar className="nx-waterfall-bar-cell">
                  <div className="nx-waterfall-bar-track">
                    <div className="nx-waterfall-bar-fill" data-tone={toDataTone(span.tone) ?? 'accent'} />
                  </div>
                </WaterfallBar>
              </WaterfallRow>
            );
          })}
        </div>
      </Waterfall>

      {selectedSpan && (
        <div className="nx-waterfall-inspector">
          <span className="nx-status-dot" data-tone={toDataTone(selectedSpan.tone) ?? 'accent'}>
            <strong>{selectedSpan.label}</strong>
          </span>
          {selectedSpan.service && <span className="nx-waterfall-inspector-meta">Service: {selectedSpan.service}</span>}
          <span className="nx-waterfall-inspector-meta">Start: +{formatDurationMs(selectedSpan.start)}</span>
          <span className="nx-waterfall-inspector-meta">Duration: {formatDurationMs(selectedSpan.duration)}</span>
          {selectedSpan.statusText && (
            <span className="nx-badge" data-tone={toDataTone(selectedSpan.tone)}>
              {selectedSpan.statusText}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
