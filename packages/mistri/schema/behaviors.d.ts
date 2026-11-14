/**
 * `@mistriwork/mistri/behaviors`: the behaviors a custom component is built on.
 *
 * A behavior is roles, keys, announcements and `data-*` on parts the component dresses itself: none draws anything.
 * Each part takes what its element takes, with three props every part shares: `render` (your own element, or a
 * function of the props and the part's state), and `className` and `style`, which may be functions of that state.
 * A part carries `data-slot` (`sortable-item`, `transfer-list`, …) and says its state as attributes
 * (`data-dragging`, `data-over`), which is what a component's stylesheet reads.
 *
 * A root's `onValueChange` hears the value and then why it changed: `reason`, the hand (`source`: a pointer, the
 * keyboard, or the page itself), the DOM `event` where there was one, and `cancel()`, which leaves the value as it
 * was. A root given `value` is controlled: it shows what it is given and asks for the change.
 *
 * The page fetches this module the first time a component imports it, so it adds nothing to an App that builds
 * nothing on it. @preview
 */
import type * as ReactTypes from 'react';

/** Why a value changed and what changed it, with the way to refuse the change. */
export type Change<Reason extends string = string, More = unknown> = {
  reason: Reason;
  /** The hand: a pointer, the keyboard, or the page itself (a change with no event behind it). */
  source: 'pointer' | 'keyboard' | 'program';
  event?: Event;
  /** Leaves the value as it was. */
  cancel: () => void;
  readonly canceled: boolean;
} & More;

/** What every part takes beside its element's own attributes. */
export type PartProps<Tag extends keyof ReactTypes.JSX.IntrinsicElements, State = {}> = Omit<
  ReactTypes.ComponentProps<Tag>,
  'className' | 'style' | 'children'
> & {
  className?: string | ((state: State) => string | undefined);
  style?: ReactTypes.CSSProperties | ((state: State) => ReactTypes.CSSProperties | undefined);
  /** Your own element, which receives the part's props, or a function of the props and the part's state. */
  render?: ReactTypes.ReactElement<Record<string, unknown>> | ((props: Record<string, unknown>, state: State) => ReactTypes.ReactElement);
  children?: ReactTypes.ReactNode | ((state: State) => ReactTypes.ReactNode);
};

/* Without this a declaration file exports every name in it; `Part` is how the parts below are written, not one of them. */
export {};

type Part<Tag extends keyof ReactTypes.JSX.IntrinsicElements, Props = {}, State = {}> = (
  props: PartProps<Tag, State> & Props,
) => ReactTypes.ReactElement | null;

/* ---------- a list whose order is the reader's ---------- */

export type SortableReason = 'drag' | 'move-key' | 'imperative';
export interface SortableProps extends Omit<PartProps<'div', { order: string[]; moving: string | null }>, 'children' | 'defaultValue'> {
  /** The order, as the items' keys. */
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[], details: Change<SortableReason>) => void;
  orientation?: 'vertical' | 'horizontal' | 'grid';
  /** What an item is picked up by: itself (the default), or the handle inside it, for an item with controls of its own. */
  by?: 'item' | 'handle';
  /** Carries a copy over the page while the item shows where it would land: for a list inside something that scrolls or clips. */
  preview?: boolean;
  /** How one item is drawn; the root draws them in the order they stand in now. */
  children: (key: string, at: number) => ReactTypes.ReactNode;
}
/** The list. Space picks an item up, the arrows place it, Escape puts it back; a pointer drags it. `data-sorting`. */
export function Sortable(props: SortableProps): ReactTypes.ReactElement | null;
/** One item. `data-grabbed`, `data-dragging`, `data-disabled`. */
export const SortableItem: Part<'div', { value: string; disabled?: boolean }, { grabbed: boolean }>;
/** The button an item is picked up by, where the root says `by="handle"`. It takes its item's `value` from the item around it. */
export const SortableHandle: Part<'button', { value?: string }, { grabbed: boolean }>;

/* ---------- things carried between lists ---------- */

export type TransferReason = 'drag' | 'move-key' | 'imperative';
/** What moved: the item, the list it left, the list it is in, and its place there. */
export type TransferMove = { key: string; from: string; to: string; index: number };
export type TransferListState = { keys: string[]; over: boolean; takes: boolean; refuses: boolean; carrying: string | null };
export interface TransferProps extends Omit<PartProps<'div', { carrying: string | null }>, 'defaultValue'> {
  /** Every list by its name, each the keys of its items in order. A key is in one list. */
  value?: Record<string, string[]>;
  defaultValue?: Record<string, string[]>;
  onValueChange?: (value: Record<string, string[]>, details: Change<TransferReason, TransferMove>) => void;
  /** Whether a list would take an item. Every list takes every item unless this says otherwise. */
  accepts?: (key: string, list: string) => boolean;
  /** The lists in the order the keyboard travels them: the order they are drawn in. */
  order?: string[];
  /** What a screen reader calls an item and a list, where their keys are not their names. */
  label?: (key: string) => string | undefined;
  listLabel?: (list: string) => string | undefined;
}
/** The lists together. `data-carrying` while something is carried. */
export function Transfer(props: TransferProps): ReactTypes.ReactElement | null;
/** One list. `data-over` under what is carried, `data-takes` or `data-refuses` by whether it would take it. */
export function TransferList(
  props: Omit<PartProps<'ul', TransferListState>, 'children'> & {
    value: string;
    children: (key: string, at: number) => ReactTypes.ReactNode;
    /** Draws something round the items (an empty list's words) from the list's state. */
    around?: (items: ReactTypes.ReactNode, state: TransferListState) => ReactTypes.ReactNode;
  },
): ReactTypes.ReactElement | null;
/** One item. `data-carried`, `data-dragging`. */
export const TransferItem: Part<'li', { value: string }, { carried: boolean }>;
/** The button an item is carried by with the keyboard or a finger. */
export const TransferHandle: Part<'button', { value?: string }, { carried: boolean }>;

/* ---------- a month of days a keyboard walks ---------- */

export type DaysReason = 'move-key' | 'focus-in' | 'imperative';
export interface DaysProps extends Omit<PartProps<'div', { month: string; day: string; weeks: string[][] }>, 'children' | 'defaultValue'> {
  /** The day the keyboard is on, as `2026-11-14`. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (day: string, details: Change<DaysReason>) => void;
  /** The month in view, as `2026-11`. */
  month?: string;
  defaultMonth?: string;
  onMonthChange?: (month: string, details: Change<DaysReason>) => void;
  /** The first day of a week: 1 is Monday, 0 Sunday. */
  weekStart?: number;
  /** The day that is today, for a page that knows it in its own zone; else the reader's. */
  today?: string;
  min?: string;
  max?: string;
  /** A day the reader may not pick: it is still walked over, and said to be unavailable. */
  unavailable?: (day: string) => boolean;
  /** Enter or Space on a day, or a press on it where `press` is set. */
  onPick?: (day: string, event: Event) => void;
  press?: boolean;
  children: (state: { month: string; day: string; weeks: string[][] }) => ReactTypes.ReactNode;
}
/** The grid: one Tab stop; arrows by day and week, Home and End to the week's edges, Page Up and Down by month. `data-month`. */
export function Days(props: DaysProps): ReactTypes.ReactElement | null;
/** One day. `data-day`, `data-outside` (another month's), `data-today`. */
export const DaysDay: Part<'div', { value: string }>;
/** A day as a date at midnight UTC. A day is said as `2026-11-14`, in no zone. */
export function dayAt(day: string): Date;
export function addDays(day: string, by: number): string;
export function monthOf(day: string): string;
export function addMonths(month: string, by: number): string;
/** The same day of the month in another month, held to that month's last day. */
export function inMonth(day: string, month: string): string;
/** Today where the reader is. */
export function localToday(): string;
/** A month's weeks, each seven days, from the days of the months beside it where a week runs over. */
export function weeksOf(month: string, weekStart: number): string[][];

/* ---------- stretches along tracks ---------- */

/** A stretch: the track it is on and where it starts and ends, in the track's own units. */
export type Span = { id: string; track: string; start: number; end: number };
export type SpansReason = 'drag' | 'move-key' | 'remove-press' | 'imperative';
export type SpanAction = 'draw' | 'move' | 'resize' | 'delete';
export interface SpansProps extends Omit<PartProps<'div', { spans: Span[]; changing: string | null }>, 'defaultValue'> {
  value?: Span[];
  defaultValue?: Span[];
  onValueChange?: (value: Span[], details: Change<SpansReason, { id: string; action: SpanAction }>) => void;
  /** Where a track starts and ends, and what a start and an end snap to. */
  min?: number;
  max?: number;
  step?: number;
  minSize?: number;
  /** Which way tracks run: `x` across (a Gantt's rows), `y` down (a day's hours). */
  axis?: 'x' | 'y';
  /** A stretch keeps to the track it is on. */
  stay?: boolean;
  locked?: (span: Span) => boolean;
  /** What a stretch is called, with where it is: what is said as it is changed. */
  label?: (span: Span) => string | undefined;
  onPick?: (id: string, event: Event) => void;
}
/** The stretches. Arrows walk between them; Alt with an arrow moves one, with Shift lengthens it. */
export function Spans(props: SpansProps): ReactTypes.ReactElement | null;
/** One track: draws the stretches on it. `data-track`. */
export function SpansTrack(
  props: Omit<PartProps<'div', { spans: Span[] }>, 'children'> & { value: string; children: (spans: Span[]) => ReactTypes.ReactNode },
): ReactTypes.ReactElement | null;
/** One stretch. An element inside with `data-span-edge="start"` or `"end"` is the edge a pointer lengthens it by. */
export const SpansSpan: Part<'div', { value: string }, { span: Span | undefined; action: SpanAction | undefined }>;

/* ---------- a position read along a line ---------- */

export type ScrubReason = 'scrub' | 'move-key' | 'focus-in' | 'focus-out' | 'escape-key';
export interface ScrubProps extends Omit<PartProps<'div', { at: number | null; last: number }>, 'children' | 'defaultValue'> {
  /** How many positions the track has. */
  count: number;
  value?: number | null;
  defaultValue?: number | null;
  onValueChange?: (value: number | null, details: Change<ScrubReason>) => void;
  /** `band`: each position owns an equal stretch of the track. `point`: the first and last are the track's ends. */
  scale?: 'band' | 'point';
  orientation?: 'horizontal' | 'vertical';
  /** What is at a position, in words: what a screen reader hears as it changes. */
  text?: (index: number) => string;
  onPick?: (index: number, event: Event) => void;
  children: (at: number | null, last: number) => ReactTypes.ReactNode;
}
/** The reader passes over a line and is told what is at each place. `data-scrubbing`. */
export function Scrub(props: ScrubProps): ReactTypes.ReactElement | null;
/** The line: a slider to the keyboard and a screen reader. `data-at`. */
export const ScrubTrack: Part<'div'>;

/* ---------- one of a list, shown beside it ---------- */

export type PickReason = 'move-key' | 'enter-key' | 'item-press' | 'escape-key' | 'close-press';
export interface PickProps extends Omit<PartProps<'div', { value: string | null; follow: boolean }>, 'defaultValue'> {
  /** The rows, in order, by their keys. */
  keys: string[];
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null, details: Change<PickReason>) => void;
  /** Walking the list picks as it goes. Off where the list and the pane are not both in view (a phone). */
  follow?: boolean;
}
export function Pick(props: PickProps): ReactTypes.ReactElement | null;
export const PickList: Part<'ul'>;
/** One row. `data-picked`. */
export const PickOption: Part<'li', { value: string }, { picked: boolean }>;
/** Where the picked one is shown. Escape in it returns to its row. */
export const PickPane: Part<'section', {}, { value: string | null }>;
/** Unpicks and returns to the row, where only one of the two is in view. */
export const PickBack: Part<'button'>;

/* ---------- a list worked one at a time ---------- */

export type TurnsReason = 'next-press' | 'previous-press' | 'imperative';
export type TurnsState = { current: string | null; at: number; handled: string[]; left: string[]; total: number };
export interface TurnsProps extends Omit<PartProps<'div', TurnsState>, 'defaultValue'> {
  /** Everything to go through, in order, by its key. */
  keys: string[];
  /** The keys that have been dealt with. */
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[], details: Change<TurnsReason>) => void;
}
/** One thing is in hand; dealing with it brings the next. `data-done` when none is left. */
export function Turns(props: TurnsProps): ReactTypes.ReactElement | null;
/** The name of the one in hand: the keyboard is put on it when it changes, so it is read out. */
export const TurnsName: Part<'h2'>;
/** Leaves the one in hand for the end. */
export const TurnsSkip: Part<'button'>;

/* ---------- column widths ---------- */

export type WidthsReason = 'drag' | 'move-key' | 'clear-press';
export interface WidthsProps extends Omit<PartProps<'div', { widths: Record<string, number>; sizing: string | null }>, 'children' | 'defaultValue'> {
  /** The widths the reader has set, in CSS pixels, by column. A column that is not here is its own width. */
  value?: Record<string, number>;
  defaultValue?: Record<string, number>;
  onValueChange?: (value: Record<string, number>, details: Change<WidthsReason, { key: string }>) => void;
  min?: number;
  max?: number;
  /** How far an arrow key moves an edge; Shift moves it five times as far. */
  step?: number;
  /** What a screen reader hears when a key sets a width or gives one back (no width). English where unsaid. */
  say?: (label: string, width: number | undefined) => string;
  children: (widths: Record<string, number>, sizing: string | null) => ReactTypes.ReactNode;
}
/** The widths. Lays nothing out. `data-sizing` while a bar is dragged. */
export function Widths(props: WidthsProps): ReactTypes.ReactElement | null;
/** A column's header cell: Alt with Left and Right sets its width from the button inside, Alt with Backspace gives it back. `data-sized`. */
export const WidthsColumn: Part<'th', { value: string; label?: string }>;
/** The bar at a column's far edge. A double press gives the width back. `data-sizing`. */
export const WidthsHandle: Part<'span', { value?: string }>;

/* ---------- values edited where they stand ---------- */

export type EditableReason = 'edit-key' | 'type' | 'double-click' | 'enter-key' | 'escape-key' | 'focus-out' | 'tab-key' | 'imperative';
export interface EditableProps extends Omit<PartProps<'div', { editing: string | null }>, 'children'> {
  /** What a value says now, by its id: what the box starts with. */
  text: (id: string) => string;
  /** Asked to keep what was typed. Return false to refuse it and keep the box open. */
  onCommit?: (id: string, text: string, details: { reason: EditableReason; event?: Event }) => boolean | void;
  /** The box was left by Escape. */
  onCancel?: (id: string) => void;
  locked?: (id: string) => boolean;
  /** Draws the values; `editing` is the id of the one whose box is open, or none. */
  children: (editing: string | null) => ReactTypes.ReactNode;
}
/** One value is edited at a time: Enter, F2 or typing starts on it, Enter and Tab keep, Escape puts it back. */
export function Editable(props: EditableProps): ReactTypes.ReactElement | null;
/** A value. `press` starts on it at a single press; without it, a double press. `data-editing`, `data-locked`. */
export const EditableValue: Part<'span', { value: string; press?: boolean }, { editing: boolean }>;
/** The box, drawn where the value being edited is. */
export const EditableInput: Part<'input'>;
