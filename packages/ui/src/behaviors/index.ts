/**
 * The behaviors, to build components on: `@mistriwork/ui/behaviors/index.js`, and for an App's own components
 * `@mistriwork/mistri/behaviors`.
 *
 * Each behavior is a UI SDK primitive (`definePrimitive`): state with changes a caller can hold, refuse or leave
 * alone, an api, and slots that put the right roles, keys and `data-*` on whatever element they are given. Nothing
 * here draws anything, and a component is made from three things:
 *
 * - the React parts (`Transfer`, `TransferList`, …): each takes `render`, `className` and `style`, carries
 *   `data-slot` and its state as `data-*`, and is dressed by the caller's stylesheet. A root's change callback hears
 *   this package's details second (./heard.ts): the reason, the hand, the event, and `cancel()` to refuse it;
 * - the primitive itself (`transfer`, `days`, …), for parts on elements of the caller's choosing:
 *   `createParts(sortable, { root: 'ol', item: 'li', handle: 'button' })`, with `createParts` from here. A primitive
 *   says UI SDK's own details;
 * - the helpers a behavior's callers need (a day's arithmetic, how much a page is zoomed).
 *
 * ../behaviors.css gives a behavior's slots only what the behavior needs to work wherever it stands (a dragged item
 * follows the pointer, a carried thing is not selected as text, a finger on a track still scrolls the page) and a
 * plain default for a grip and for a value that can be edited, which a rule of the caller's replaces. What a
 * component looks like is said of that component, never of the slot.
 *
 * They are apart from the controls on purpose: no control imports one, so a page that draws no board and no calendar
 * fetches none of this. What each one is for, its options and its slots are said at the top of its file.
 */

export { createParts } from '@ui-sdk/react/primitive';
export { Days, DaysDay } from './DaysParts.js';
export { addDays, addMonths, dayAt, days, type DaysOptions, type DaysReason, inMonth, localToday, monthOf, weeksOf } from './days.js';
export { zoomOf } from './dress.js';
export type { Change } from './heard.js';
export { Editable, EditableInput, EditableValue } from './EditableParts.js';
export { editable, type EditableOptions } from './editable.js';
export { Pick, PickBack, PickList, PickOption, PickPane } from './PickParts.js';
export { pick, type PickOptions, type PickReason } from './pick.js';
export { Scrub, ScrubTrack } from './ScrubParts.js';
export { scrub, type ScrubOptions, type ScrubReason } from './scrub.js';
export { Sortable, SortableHandle, SortableItem } from './SortableParts.js';
export { sortable, type SortableOptions, type SortableOrientation, type SortableReason } from './sortable.js';
export { type Span, Spans, SpansSpan, SpansTrack } from './SpansParts.js';
export { spans, type SpansChange, type SpansOptions } from './spans.js';
export { Transfer, TransferHandle, TransferItem, TransferList, type TransferListState } from './TransferParts.js';
export { transfer, type TransferMove, type TransferOptions, type TransferReason } from './transfer.js';
export { Turns, TurnsName, TurnsSkip } from './TurnsParts.js';
export { turns, type TurnsOptions, type TurnsReason } from './turns.js';
export { Widths, WidthsColumn, WidthsHandle } from './WidthsParts.js';
export { widths, type WidthsOptions, type WidthsReason } from './widths.js';
