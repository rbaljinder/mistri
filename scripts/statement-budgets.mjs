/**
 * What a warm room or command may ask of the server and the database, held
 * to a ceiling — beside the bundle budget (bundle-budget.mjs) and on the same
 * terms. The telemetry sweep of 0.8.2 found a Keystone command sending 38
 * statements, seven of them catalog reads, a row-policy record page 84
 * catalog reads, and a dashboard asking seventeen requests to paint: nothing
 * measured them, so nothing stopped them growing. These do.
 *
 * Measured by the dev observer's own instrumentation: every request it
 * traces, and every statement a driver sends inside one
 * (test/support/statements.ts). A room also counts its `requests`. Three
 * numbers per command:
 * - `statements`: all of them, warm (the second request, the catalog cached);
 * - `catalog`: reads of the system catalog. Zero, always: a warm request
 *   reads one epoch (SQLite's schema versions, PostgreSQL's epoch store,
 *   adapters/epochCache.ts), which is not counted here, and nothing else;
 * - `repeated`: statements whose shape already ran in the same request, the
 *   N+1 pattern. Zero in the platform's own statements; a row scope checks a
 *   row it writes before and after the write, by design, and a handler that
 *   reads the row it then writes asks the scope the same question.
 *
 * Raising a ceiling is allowed; it is a decision, made here, with the reason
 * beside it. Held by test/statement-budget.test.ts (commands, both engines)
 * and e2e/statement-budget.spec.ts (the rooms of a sample App).
 */
export const COMMAND_BUDGETS = {
  /* A browser's command on a record (track none): BEGIN with the epoch,
     the target as `when` admits it, the handler's own UPDATE, COMMIT. The
     sqlite ceiling counts BEGIN and COMMIT as the statements node:sqlite
     runs them as. Was 21 on SQLite before 0.8.2 (the journal attested twice,
     a receipt lookup, a before image, a count before the write). */
  'sqlite command, none': { statements: 5, catalog: 0, repeated: 0 },
  /* The same with a receipt (the App API, MCP, a job, an Idempotency-Key):
     one read that the key is new, and the receipt and its audit written
     together (SQLite needs two statements for the two rows). */
  'sqlite command, receipts': { statements: 8, catalog: 0, repeated: 0 },
  /* `audit`: the before image of each write is read, as the audit keeps it. */
  'sqlite command, audit': { statements: 9, catalog: 0, repeated: 0 },
  /* A row-scoped write: the row checked in scope under its lock before and
     after, and the write. The scope catalog was one PRAGMA per table per
     transaction (84 on Forecourt's record page); now it is kept by epoch. */
  'sqlite scoped write': { statements: 6, catalog: 0, repeated: 1 },
  /* PostgreSQL: BEGIN, the scope's LOCK and the epoch in one message; the
     target; COMMIT. Was 38 on the Keystone marketplace's removeSavedVehicle. */
  'postgres command, none': { statements: 4, catalog: 0, repeated: 0 },
  'postgres command, receipts': { statements: 6, catalog: 0, repeated: 0 },
  /* The row policy's guards: the target locked and read in scope before and
     after the write, the parent it points at held and counted in scope. */
  'postgres scoped command, none': { statements: 9, catalog: 0, repeated: 2 },
};

/* A room: every request the browser makes opening it, and every statement
   those requests send, summed, warm. The catalog reads and the N+1 patterns
   the dev observer flags stay at zero unless a number says otherwise; the
   totals are what the rooms read at 0.8.2, with room for the ordinary change,
   and the 0.8.1 sweep's numbers beside them.

   Requests are counted as a built client makes them (the dev server's own
   module requests aside). A page loaded from its address asks the shell for
   six things before its room — the page, who is signed in, the runtime, the
   schema, the App, its pages — and the saved views; a room opened from the
   menu asks only for its own data. */
export const ROOM_BUDGETS = {
  /* The home dashboard, loaded from its address: the shell's seven, and its
     cards' breakdowns and lists in one request. Was 15 requests (a list
     apiece, and an undo lookup on every start, asked now at the first undo)
     and 14 statements. 0.9.1's menu counts its lists of work (pay runs under way, active employees, upcoming
     events), each a bounded COUNT in the page's own request, no N+1: 18 statements, was 16. */
  'payday home': { requests: 9, statements: 18 },
  /* Time off: the shell's seven, the rows, every tab's count in one request.
     Was 10 requests and 6 statements. */
  'payday list': { requests: 10, statements: 7 },
  /* A time-off request, opened from the list: the record, its related
     lists, its command's availability. Was 8 requests and 12 statements,
     one of them a catalog read on every open. */
  'payday record': { requests: 9, statements: 14 },
  /* The same list opened from the menu: its rows and its tabs' counts. */
  'payday list, from the menu': { requests: 3, statements: 7 },
  /* Thread's home: the dashboard's numbers and lists together. Was 17
     requests, 8 of them a list apiece. Its board reads a page per lane,
     five of one shape in one request, which the observer flags: one
     pattern, allowed until a board is read in one statement. */
  'thread home': { requests: 10, statements: 20, nPlusOne: 1 },
  /* Issues: the shell's seven, the rows, the tabs' counts in one statement.
     Was 10 requests and 5 statements (a count per tab, read as a view). */
  'thread list': { requests: 10, statements: 4 },
};
