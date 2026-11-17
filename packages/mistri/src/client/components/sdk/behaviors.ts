/**
 * `@mistriwork/mistri/behaviors`: the behaviors a custom component is built on. A list whose order is the reader's
 * (`Sortable`), things carried between lists (`Transfer`), a month a keyboard walks (`Days`), stretches along tracks
 * (`Spans`), a position read along a line (`Scrub`), one picked from a list and shown beside it (`Pick`), a list worked
 * one at a time (`Turns`), column widths (`Widths`) and values edited where they stand (`Editable`). Each is roles,
 * keys, announcements and `data-*` on parts the component dresses itself; none draws anything
 * (@mistriwork/ui's behaviors/index.ts says what each is for).
 *
 * It is a host module of its own and not part of `@mistriwork/mistri/ui`: the page fetches it the first time a
 * component imports it (host.tsx, `load`), so an App with no board and no calendar of its own never downloads a drag.
 * Its value exports are `BEHAVIORS_EXPORTS` (shared/uiSdk.ts), which a test holds to this list; its types are
 * packages/mistri/schema/behaviors.d.ts. Published, it is built to dist/ui for a component's tests
 * (config/vite.ui.config.ts).
 */
import './behaviors.css';

export {
  addDays,
  addMonths,
  dayAt,
  Days,
  DaysDay,
  Editable,
  EditableInput,
  EditableValue,
  inMonth,
  localToday,
  monthOf,
  Pick,
  PickBack,
  PickList,
  PickOption,
  PickPane,
  Scrub,
  ScrubTrack,
  Sortable,
  SortableHandle,
  SortableItem,
  Spans,
  SpansAxis,
  SpansNow,
  SpansRegion,
  SpansSpan,
  SpansTrack,
  Transfer,
  TransferHandle,
  TransferItem,
  TransferList,
  Turns,
  TurnsName,
  TurnsSkip,
  weeksOf,
  Widths,
  WidthsColumn,
  WidthsHandle,
} from '@mistriwork/ui/behaviors/index.js';
