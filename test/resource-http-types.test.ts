import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isImportDeclaration, isInterfaceDeclaration, isTypeAliasDeclaration, SyntaxKind } from 'typescript/unstable/ast';
import { parseFile, transpile } from './support/tsc.js';
import { appDataResponse } from '../packages/mistri/src/server/app/appResponses.js';
import * as publicRuntime from '../packages/engine/src/shared/resourceHttp.js';
import type {
  HttpAppBreakdownSuccess,
  HttpAppQuerySuccess,
  HttpAppRunSuccess,
  HttpAppViewSuccess,
  HttpDbBreakdownSuccess,
  HttpDbQuerySuccess,
  HttpDbRunSuccess,
  HttpDbViewSuccess,
  HttpDeleteFailure,
  HttpDiagnostic,
  HttpFilter,
  HttpHistoryEntry,
  HttpHistoryPreview,
  HttpInsertSuccess,
  HttpReadFailure,
  HttpRevertRequest,
  HttpSql,
  HttpUndoFailure,
  HttpUpdateRequest,
  HttpViewDefinition,
  ResourceHttpBodies,
  ResourceHttpContract,
  ResourceHttpFailure,
  ResourceHttpPath,
  ResourceHttpReply,
  ResourceHttpRequest,
  ResourceHttpSuccess,
} from '../packages/engine/src/shared/resourceHttp.js';

const sql: HttpSql = { text: 'SELECT private_expression FROM private_table WHERE id = ?', params: [1] };
const rowSet = { columns: ['id'], rows: [{ id: '9007199254740993' }], ms: 1 };
const order = { order: [{ column: 'id', direction: 'asc' as const }], implicit: true };
const view: HttpViewDefinition = { id: 'items', name: 'Items', base: 'item', columns: [{ path: 'id' }] };
const resolved = [{ path: 'id', name: 'id', table: 'item', column: 'id', type: 'integer', nullable: false, primaryKey: true, hops: 0 }];
const joins = [{ alias: 'private_alias', table: 'item', path: 'parent_id' }];
const query: HttpDbQuerySuccess = { ...rowSet, order, sql };
const viewReply: HttpDbViewSuccess = {
  ...rowSet,
  view,
  text: 'item show id',
  resolved,
  joins,
  sql,
  explain: sql.text,
  limit: 20,
  offset: 0,
  more: false,
  errors: [],
};
const breakdown: HttpDbBreakdownSuccess = {
  ...rowSet,
  breakdown: { base: 'item', by: [], measures: [{ fn: 'count' }], limit: 20 },
  resolved: [{ name: 'count', kind: 'measure', fn: 'count', type: 'integer' }],
  offset: 0,
  sql,
};
const entry: HttpHistoryEntry = {
  id: 1,
  kind: 'update',
  at: '2026-09-07T00:00:00Z',
  summary: 'Updated item',
  by: 'Operator',
  revertible: false,
  blocksUndo: true,
  undoState: 'unknown',
  reason: 'Refresh and reconcile.',
};

// These expressions are checked by tsc alongside the runtime tests. Negative
// cases stay uncalled: they demonstrate rejected contracts, not runtime guards.
function compileTimeFixtures() {
  const requests = {
    '/api/query': { table: 'item', filter: { groups: [[]] }, columns: ['id'], limit: '2.9', offset: null },
    '/api/count': { table: 'item', filter: null, exactCount: true },
    '/api/run': { q: 'item show id', columns: ['id'], exactCount: true, limit: 2 },
    '/api/view/run': { view: { base: 'item', columns: ['id'], orderBy: [{ path: 'id' }] }, query: 'id > 1', count: 'none' },
    '/api/breakdown': { def: { base: 'item', by: [], measures: [{ fn: 'count' }] }, offset: '1' },
    '/api/update': { table: 'item', key: { id: '9007199254740993' }, values: { enabled: false }, expected: { enabled: null } },
    '/api/insert': { table: 'item', values: {} },
    '/api/delete': { table: 'item', key: { id: 1 }, confirm: false },
    '/api/revert': { confirm: true, expectedId: 1 },
  } satisfies ResourceHttpBodies;
  const app: ResourceHttpRequest<'/api/query', 'app'> = { app: 'desk', ...requests['/api/query'] };
  const db: ResourceHttpRequest<'/api/query', 'db'> = { conn: 'database', ...requests['/api/query'] };
  const textView: ResourceHttpRequest<'/api/view/run'> = { text: 'item show id' };
  const textBreakdown: ResourceHttpRequest<'/api/breakdown'> = { text: 'item count' };
  const oneField: HttpUpdateRequest = { table: 'item', key: { id: 1 }, column: 'name', value: null };
  const nullDefault: HttpUpdateRequest = { table: 'item', key: { id: 1 }, column: 'name' };
  const historyPreview: HttpRevertRequest = {};
  const acceptedFilters: HttpFilter[] = [
    { groups: [] },
    { groups: [[]] },
    { groups: [[{ column: 'id', op: 'in', value: [1, '2', false, null] }]] },
    { groups: [[{ column: 'name', op: 'isNull' }]] },
  ];
  // @ts-expect-error App wire selectors do not expose physical connections.
  const wrongApp: ResourceHttpRequest<'/api/query', 'app'> = { conn: 'private', table: 'item' };
  // @ts-expect-error DB wire selectors do not accept App identity.
  const wrongDb: ResourceHttpRequest<'/api/query', 'db'> = { app: 'desk', table: 'item' };
  // @ts-expect-error Request shape follows the selected route.
  const wrongRoute: ResourceHttpRequest<'/api/count'> = { q: 'item' };
  // @ts-expect-error Undo confirmation must carry its preview's expected ID.
  const blindUndo: HttpRevertRequest = { confirm: true };
  // @ts-expect-error An empty view request has neither a base nor text.
  const emptyView: ResourceHttpRequest<'/api/view/run'> = {};
  // @ts-expect-error Insert values must be explicit, even for database defaults.
  const emptyInsert: ResourceHttpRequest<'/api/insert'> = { table: 'item' };
  // @ts-expect-error Scalar comparisons cannot bind arrays.
  const arrayComparison: HttpFilter = { groups: [[{ column: 'id', op: '=', value: [1] }]] };
  // @ts-expect-error IN takes an array.
  const scalarIn: HttpFilter = { groups: [[{ column: 'id', op: 'in', value: 1 }]] };
  // @ts-expect-error Unknown operators are not accepted.
  const unknownOp: HttpFilter = { groups: [[{ column: 'id', op: 'bogus', value: 1 }]] };
  // @ts-expect-error The service's count mode is not a new HTTP field.
  const countMode: ResourceHttpRequest<'/api/run'> = { q: 'item', countMode: 'estimate' };
  // @ts-expect-error View counts have only exact or none modes.
  const badViewCount: ResourceHttpRequest<'/api/view/run'> = { text: 'item show id', count: 'estimate' };

  const noCount: HttpAppRunSuccess = {
    ...rowSet,
    table: 'item',
    view,
    text: 'item show id',
    resolved,
    joinCount: 0,
    limit: 20,
    offset: 0,
    errors: [],
  };
  const recordRun: HttpDbRunSuccess = {
    ...query,
    table: 'item',
    total: 4,
    exactTotal: false,
    limit: 20,
    offset: 0,
    errors: [],
    explain: sql.text,
  };
  const dbViewRun: HttpDbRunSuccess = {
    ...rowSet,
    table: 'item',
    view,
    text: 'item show id',
    resolved,
    joins,
    limit: 20,
    offset: 0,
    errors: [],
    explain: sql.text,
  };
  const parseFailure: ResourceHttpReply<'/api/run', 'app'> = { errors: [{ message: 'Incomplete query', at: 5 }] };
  const dbParseFailure: ResourceHttpFailure<'/api/run', 'db'> = { errors: [{ message: 'Incomplete query' }], explain: 'item' };
  const breakdownFailure: ResourceHttpFailure<'/api/breakdown', 'app'> = { errors: [{ code: 'data_unavailable', message: 'Unavailable' }] };
  // An API reports no count (adapters/http): its record run pages by whether a full page came back.
  const missingRecordTotal: HttpDbRunSuccess = { ...query, table: 'item', limit: 20, offset: 0, errors: [], explain: 'item' };
  // @ts-expect-error Parse failures cannot include partial rows.
  const partialRows: HttpReadFailure = { errors: [{ message: 'Invalid filter' }], rows: [] };
  // @ts-expect-error Raw DB results cannot be assigned to projected App results, even through a variable.
  const leakedQuery: HttpAppQuerySuccess = query;
  // @ts-expect-error App parse failures omit compiler explanations.
  const leakedParse: ResourceHttpFailure<'/api/run', 'app'> = { errors: [{ message: 'Invalid' }], explain: sql.text };
  // @ts-expect-error App views expose joinCount, never raw joins/aliases.
  const leakedView: HttpAppViewSuccess = { ...viewReply, joinCount: 1 };
  // @ts-expect-error App breakdowns omit parameterized SQL.
  const leakedBreakdown: HttpAppBreakdownSuccess = breakdown;
  // @ts-expect-error A normal query does not advertise a total.
  const inventedQueryTotal: HttpDbQuerySuccess = { ...query, total: 2 };
  // @ts-expect-error SQL does not appear in the current query-bar view envelope.
  const inventedViewSql: HttpDbRunSuccess = { ...dbViewRun, sql };
  // @ts-expect-error Breakdown limit is carried inside breakdown, not at the response root.
  const inventedLimit: HttpDbBreakdownSuccess = { ...breakdown, limit: 20 };

  const update: ResourceHttpSuccess<'/api/update', 'app'> = { affected: 1, applied: { name: 'new' } };
  const insert: HttpInsertSuccess = { key: { id: '9007199254740993' }, applied: { name: 'new' } };
  const rejected: ResourceHttpFailure<'/api/update', 'app'> = {
    errors: [{ code: 'duplicate_value', message: 'Taken' }],
    outcome: 'rejected',
  };
  const unknown: ResourceHttpFailure<'/api/insert', 'app'> = {
    error: 'Unconfirmed',
    errors: [{ code: 'write_unconfirmed', message: 'Unconfirmed' }],
    outcome: 'unknown',
  };
  const deletePreview: ResourceHttpSuccess<'/api/delete', 'db'> = { impact: [], deleted: false };
  const deleteUnknown: HttpDeleteFailure = { deleted: null, outcome: 'unknown', errors: [{ message: 'Unconfirmed' }] };
  const preview: HttpHistoryPreview = { reverted: false, writes: [entry] };
  const undoUnknown: HttpUndoFailure = { reverted: false, outcome: 'unknown', errors: [{ code: 'undo_failed', message: 'Unconfirmed' }] };
  const undoRejected: ResourceHttpFailure<'/api/revert', 'app'> = { error: 'History changed', outcome: 'not_applied' };
  const contract: ResourceHttpContract<'/api/update', 'app'> = {
    request: requests['/api/update'],
    success: update,
    failure: rejected,
    reply: update,
  };
  // @ts-expect-error An unknown deletion is not proof that the row remains.
  const falseUnknown: HttpDeleteFailure = { deleted: false, outcome: 'unknown', errors: [{ message: 'Unconfirmed' }] };
  // prettier-ignore
  // @ts-expect-error Write failures cannot acknowledge applied values.
  const partialWrite: ResourceHttpFailure<'/api/update', 'app'> = { errors: [{ message: 'Unconfirmed' }], outcome: 'unknown', applied: { name: 'new' } };
  // @ts-expect-error Current write successes do not introduce an outcome field.
  const newSuccessFlag: ResourceHttpSuccess<'/api/update', 'app'> = { ...update, outcome: 'applied' };
  // @ts-expect-error Private journal ownership must not cross the history boundary.
  const privateOwner: HttpHistoryEntry = { ...entry, connection: 'physical', principal: 'account', app: 'desk' };
  // @ts-expect-error Stored before/after images are not public history entries.
  const privateImages: HttpHistoryEntry = { ...entry, steps: [{ table: 'item', before: { name: 'old' } }] };
  // @ts-expect-error No new server authority appears in an operation request.
  const forgedPrincipal: ResourceHttpRequest<'/api/update', 'app'> = { ...requests['/api/update'], principal: 'another-account' };
  // @ts-expect-error Provider/driver codes are not the App diagnostic vocabulary.
  const driverCode: HttpDiagnostic = { code: '23505', message: 'private driver error' };
  return [
    requests,
    app,
    db,
    textView,
    textBreakdown,
    oneField,
    nullDefault,
    historyPreview,
    acceptedFilters,
    wrongApp,
    wrongDb,
    wrongRoute,
    blindUndo,
    emptyView,
    emptyInsert,
    arrayComparison,
    scalarIn,
    unknownOp,
    countMode,
    badViewCount,
    noCount,
    recordRun,
    dbViewRun,
    parseFailure,
    dbParseFailure,
    breakdownFailure,
    missingRecordTotal,
    partialRows,
    leakedQuery,
    leakedParse,
    leakedView,
    leakedBreakdown,
    inventedQueryTotal,
    inventedViewSql,
    inventedLimit,
    update,
    insert,
    rejected,
    unknown,
    deletePreview,
    deleteUnknown,
    preview,
    undoUnknown,
    undoRejected,
    contract,
    falseUnknown,
    partialWrite,
    newSuccessFlag,
    privateOwner,
    privateImages,
    forgedPrincipal,
    driverCode,
  ];
}
void compileTimeFixtures;

test('resource HTTP contracts have no runtime imports, exports or executable implementation', () => {
  const source = readFileSync(new URL('../packages/engine/src/shared/resourceHttp.ts', import.meta.url), 'utf8');
  const parsed = parseFile(fileURLToPath(new URL('../packages/engine/src/shared/resourceHttp.ts', import.meta.url)));
  for (const statement of parsed.statements) {
    if (isImportDeclaration(statement)) assert.equal(statement.importClause?.phaseModifier, SyntaxKind.TypeKeyword);
    else assert.ok(isTypeAliasDeclaration(statement) || isInterfaceDeclaration(statement));
  }
  const emitted = transpile(source, { target: 'es2023', module: 'esnext', verbatimModuleSyntax: true, removeComments: true });
  assert.equal(emitted.trim(), 'export {};');
  assert.deepEqual(Object.keys(publicRuntime), []);
});

test('the route map names exactly the nine existing resource operations', () => {
  const paths = {
    '/api/query': true,
    '/api/count': true,
    '/api/run': true,
    '/api/view/run': true,
    '/api/breakdown': true,
    '/api/update': true,
    '/api/insert': true,
    '/api/delete': true,
    '/api/revert': true,
  } satisfies Record<ResourceHttpPath, true>;
  assert.equal(Object.keys(paths).length, 9);
});

test('query projection matches its distinct App and DB success DTOs', () => {
  const expected: HttpAppQuerySuccess = { ...rowSet, order };
  assert.deepEqual(appDataResponse(query, true), expected);
  assert.equal(appDataResponse(query, false), query);
});

test('view projection removes SQL and aliases while preserving unknown totals', () => {
  const expected: HttpAppViewSuccess = {
    ...rowSet,
    view,
    text: 'item show id',
    resolved,
    joinCount: 1,
    limit: 20,
    offset: 0,
    more: false,
    errors: [],
  };
  const projected = appDataResponse(
    { ...viewReply, resolved: resolved.map((column) => ({ ...column, expression: 'private_expression', source: 'private_source' })) },
    true,
  );
  assert.deepEqual(projected, expected);
  assert.equal(Object.hasOwn(projected, 'total'), false);
  assert.doesNotMatch(JSON.stringify(projected), /private_/);
});

test('breakdown projection preserves definitions and optional counts without adding root limit', () => {
  const expected: HttpAppBreakdownSuccess = { ...rowSet, breakdown: breakdown.breakdown, resolved: breakdown.resolved, offset: 0 };
  assert.deepEqual(appDataResponse(breakdown, true), expected);
  const textResult: HttpDbBreakdownSuccess = {
    ...breakdown,
    text: 'item count',
    section: { kind: 'metric', table: 'item' },
    explain: sql.text,
  };
  const textExpected: HttpAppBreakdownSuccess = { ...expected, text: 'item count', section: { kind: 'metric', table: 'item' } };
  assert.deepEqual(appDataResponse(textResult, true), textExpected);
  assert.equal(Object.hasOwn(expected, 'limit'), false);
});

test('HTTP 200 read diagnostics carry no rows and App projection drops explain', () => {
  const db: ResourceHttpFailure<'/api/run', 'db'> = { errors: [{ message: 'Incomplete query', at: 5 }], explain: sql.text };
  const app: ResourceHttpFailure<'/api/run', 'app'> = { errors: [{ message: 'Incomplete query', at: 5 }] };
  assert.deepEqual(appDataResponse({ ...db }, true), app);
  assert.equal(Object.hasOwn(app, 'rows'), false);
});

test('write projection retains acknowledgements and delete uncertainty without adding success outcomes', () => {
  const app: ResourceHttpSuccess<'/api/update', 'app'> = { affected: 1, applied: { name: 'new' }, undoId: 1 };
  const db: ResourceHttpSuccess<'/api/update', 'db'> = { ...app, sql };
  assert.deepEqual(appDataResponse({ ...db }, true, 'write'), app);
  const unknown: HttpDeleteFailure = {
    impact: [],
    deleted: null,
    outcome: 'unknown',
    errors: [{ message: 'Refresh and reconcile.', code: 'write_unconfirmed' }],
  };
  assert.deepEqual(appDataResponse(unknown, true, 'write'), unknown);
  assert.equal(Object.hasOwn(app, 'outcome'), false);
});

test('public history DTO retains barriers and public attribution without private owners or images', () => {
  const preview: ResourceHttpSuccess<'/api/revert', 'app'> = { reverted: false, writes: [entry] };
  const wire = JSON.parse(JSON.stringify(preview));
  assert.deepEqual(wire.writes[0], entry);
  for (const field of ['connection', 'principal', 'app', 'steps']) assert.equal(Object.hasOwn(wire.writes[0], field), false);
  assert.equal(wire.writes[0].undoState, 'unknown');
  assert.equal(wire.writes[0].blocksUndo, true);
  assert.equal(wire.writes[0].by, 'Operator');
});
