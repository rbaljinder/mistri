/** What PagePreview says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  unsavedPagePreview: 'Unsaved page preview',
  pagePreview: 'Page preview',
  previewViewport: 'Preview viewport',
  desktop: 'Desktop',
  mobile: 'Mobile',
  pxUnsavedReadOnly: '{width}px · Unsaved · Read-only',
  closePreview: 'Close preview',
  pageLayoutPreview: 'Page layout preview',
  doctypeHtmlHtmlHead:
    "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
  theConnectionChangedClose: 'The connection changed. Close this preview and reopen the page editor.',
  theBaseTableIsUnavailable: 'The base table is unavailable.',
  loadingPreview: 'Loading preview...',
  noRecordIsAvailable: 'No record is available to preview this layout.',
});
