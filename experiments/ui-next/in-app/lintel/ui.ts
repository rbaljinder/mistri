/* Everything Lintel's ui-next pages draw with, from one module.

   Here it only gathers them: the library, the few UI SDK parts a page composes itself, and the icons. In the App it
   is the seam that keeps UI SDK to one copy on the page. mistri compiles the kit and every page to a file of its
   own, so each would carry its own UI SDK, and UI SDK keeps state of its own (a toaster, the stack of open layers)
   that two copies do not share. `scripts/try-in-app.mjs` therefore has the kit load this module once and hold it,
   and gives the pages a stand-in with the same names that reads from the kit's.

   So a page imports from here and from nowhere else in ui-next, and a name it needs is added to the lists below. */
export {
  Activity,
  Board,
  Breadcrumbs,
  Button,
  ChoiceField,
  DataTable,
  DateField,
  DropMenu,
  Facts,
  FormProblems,
  ListView,
  listStateFromWords,
  listStateToWords,
  Mark,
  MoneyField,
  Properties,
  setWords,
  RecordHeader,
  RecordLayout,
  RecordSection,
  SidePanel,
  Skeleton,
  Stages,
  Stats,
  Status,
  TextField,
  Toaster,
  useForm,
  Worklist,
} from '../../src';
export type { ActivityEvent, BoardLane, BoardVerb, Column, ListState, StatItem, Tone, WorkItem } from '../../src';
export { Avatar, AvatarFallback } from '@ui-sdk/react/avatar';
export { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
export { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control';
export { toast } from '@ui-sdk/react/toast';
export {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CalendarBlank,
  Check,
  DotsThree,
  DownloadSimple,
  House,
  Plus,
  Receipt,
  Warning,
  Wrench,
} from '@phosphor-icons/react';
