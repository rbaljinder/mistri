/**
 * The routes a tenant App's server answers (tenantHttp.ts), by kind — the
 * context's controls, reads, writes, commands and metadata — and the fields
 * each one's body may carry: a body naming any other field is refused before
 * anything reads it.
 */
import { FILE_READ_PATH, FILE_UPLOAD_PATH } from '@mistriwork/engine/server/http/reply.js';
import { PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';
import { IMPORT_LIMITS } from '../../shared/appImportDeclaration.js';
import { TENANT_BOOT_PATH, TENANT_ENTER_PATH } from '../../shared/tenantBoot.js';
import { DECISION_PATHS } from '../http/decisionRoutes.js';

export const TENANT_CONTROL_ROUTES: ReadonlySet<string> = new Set([
  '/api/tenant/bootstrap',
  TENANT_ENTER_PATH,
  '/api/tenant/context/open',
  '/api/tenant/context/switch',
  '/api/tenant/context/recover',
  '/api/tenant/context/renew',
  '/api/tenant/context/release',
  '/api/tenant/context/resume',
]);
/* `/api/breakdowns` is a dashboard's cards in one request: one admission and
   one context where each card was a request of its own. Not on a support lease,
   whose every read is ledgered as the one read it is (below). */
export const TENANT_READ_ROUTES: ReadonlySet<string> = new Set([
  '/api/query',
  '/api/count',
  '/api/counts',
  '/api/run',
  '/api/view/run',
  '/api/breakdown',
  '/api/breakdowns',
  FILE_READ_PATH,
]);
/* The file travels as JSON text, where a quote or a line break is written with two characters (http/importRoutes.ts). */
export const IMPORT_BODY = IMPORT_LIMITS.bytes * 2 + 64 * 1024;
/* Two raster logos at their bound (256 KiB each) as base64, the light and the dark, and the value beside them. */
export const BRANDING_SAVE_BODY = 800_000;
export const TENANT_WRITE_ROUTES: ReadonlySet<string> = new Set([
  '/api/update',
  '/api/insert',
  '/api/delete',
  '/api/revert',
  '/api/import',
  FILE_UPLOAD_PATH,
]);
export const TENANT_COMMAND_ROUTES: ReadonlySet<string> = new Set([
  '/api/commands/availability',
  '/api/commands/prepare',
  '/api/commands/execute',
  '/api/commands/status',
]);
export const TENANT_METADATA_GETS: ReadonlySet<string> = new Set(['/api/runtime', '/api/app', '/api/pages', '/api/pages/suggested']);
export const TENANT_METADATA_POSTS: ReadonlySet<string> = new Set([
  '/api/pages/plan',
  '/api/pages/compose',
  '/api/references',
  '/api/record-history',
  '/api/record-activity',
  '/api/record-flows',
  '/api/record-flows/start',
  ...DECISION_PATHS,
  '/api/inbox',
  '/api/inbox/read',
  '/api/inbox/email',
  '/api/tokens',
  '/api/tokens/issue',
  '/api/tokens/revoke',
  '/api/branding',
  '/api/branding/save',
  '/api/integrations',
  '/api/integrations/save',
  PAGE_LOAD_PATH,
  TENANT_BOOT_PATH,
]);
export const TENANT_ROUTE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [PAGE_LOAD_PATH]: ['page', 'params'],
  [TENANT_BOOT_PATH]: ['path', 'search', 'reads'],
  '/api/pages/plan': ['page', 'key'],
  '/api/pages/compose': ['page', 'key', 'rows', 'tab'],
  '/api/references': ['table', 'key'],
  '/api/record-history': ['table', 'key', 'before', 'limit'],
  '/api/record-activity': ['view', 'section', 'period'],
  '/api/record-flows': ['table', 'key'],
  '/api/record-flows/start': ['table', 'key', 'flow'],
  '/api/record-decisions': ['table', 'key'],
  '/api/record-decisions/marks': ['table', 'keys'],
  '/api/record-decisions/why': ['id'],
  '/api/record-decisions/settle': ['id', 'action'],
  '/api/inbox': ['limit', 'before', 'unread'],
  '/api/inbox/read': ['ids', 'all'],
  '/api/inbox/email': ['email'],
  '/api/tokens': [],
  '/api/tokens/issue': ['label', 'roles', 'operations', 'days'],
  '/api/tokens/revoke': ['id'],
  '/api/branding': [],
  '/api/branding/save': ['branding', 'logo', 'darkLogo'],
  '/api/integrations': [],
  '/api/integrations/save': ['integration', 'secrets'],
  '/api/query': ['table', 'filter', 'columns', 'orderBy', 'limit', 'offset'],
  '/api/count': ['table', 'filter', 'exactCount', 'countLimit'],
  '/api/counts': ['items', 'countLimit'],
  '/api/run': ['q', 'columns', 'exactCount', 'countLimit', 'count', 'limit', 'offset'],
  '/api/view/run': ['view', 'text', 'query', 'count', 'limit', 'offset'],
  '/api/breakdown': ['def', 'text', 'limit', 'offset'],
  '/api/breakdowns': ['items'],
  '/api/update': ['table', 'key', 'values', 'column', 'value', 'expected'],
  '/api/insert': ['table', 'values', 'lines'],
  [FILE_UPLOAD_PATH]: ['table', 'values', 'file'],
  [FILE_READ_PATH]: ['table', 'key', 'variant', 'inline'],
  '/api/delete': ['table', 'key', 'confirm'],
  '/api/import': ['table', 'view', 'name', 'csv', 'mapping', 'mode', 'skipRefused'],
  '/api/revert': ['confirm', 'expectedId', 'limit'],
  '/api/tenant/context/open': [],
  [TENANT_ENTER_PATH]: ['path', 'search', 'tenant', 'kept'],
  '/api/tenant/context/switch': ['tabId', 'expectedContext', 'expectedRevision'],
  '/api/tenant/context/renew': ['tabId', 'expectedContext', 'expectedRevision'],
  '/api/tenant/context/recover': ['tabId'],
  '/api/tenant/context/release': ['tabId', 'expectedContext', 'expectedRevision'],
  '/api/tenant/context/resume': ['tabId'],
  '/api/commands/prepare': ['command', 'commandVersion', 'key'],
  '/api/commands/availability': ['checks'],
  '/api/commands/execute': ['command', 'commandVersion', 'key', 'expectedVersion', 'idempotencyKey', 'input'],
  '/api/commands/status': ['command', 'commandVersion', 'key', 'expectedVersion', 'idempotencyKey', 'input'],
};
