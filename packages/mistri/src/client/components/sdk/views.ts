/**
 * `@mistriwork/mistri/views`: first-class composite product views (DataTable, KanbanBoard, ReviewQueueView,
 * SplitView, CalendarView, GanttView, AccountSettingsView, ActivityTimeline, CsvImportWizard, AiAssistantPanel, ...),
 * fetched once on demand with their own stylesheet (and the primitives' and charts', which they draw on) when a page
 * or component imports them. The views' sheet stands over the other two, so it is imported after them.
 */
import './sheetPrimitives.js';
import './surfaces-views.css';

export * from '@mistriwork/ui/views.js';
