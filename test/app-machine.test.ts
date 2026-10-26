import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';
import { machine } from '@mistriwork/mistri/app';
import { appTransitionRules, parseAppConfig, resolveResources, resolveViews } from '../packages/mistri/src/shared/app.js';
import {
  machineActions,
  machinePath,
  machineProblems,
  parseMachine,
  withMachineSteppers,
} from '../packages/mistri/src/shared/appMachine.js';
import { validatePage, type PageDef } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { catalogOf } from './support/commandCatalog.js';
import { machineChecks, machineCommandWarnings } from '../packages/mistri/src/server/app/appMachineChecks.js';

/* An application: submitted, reviewed (perhaps after documents), decided; withdrawn from any open state. */
const withdraw = { to: 'withdrawn', label: 'Withdraw', reason: 'note' } as const;
const states = {
  submitted: { on: { assign: 'in_review', withdraw } },
  in_review: { on: { review: ['manager_review', 'documents'], withdraw } },
  documents: { on: { review: ['manager_review', 'documents'], withdraw } },
  manager_review: { on: { decide: ['approved', 'declined'], withdraw } },
  approved: { final: true },
  declined: { final: true },
  withdrawn: { final: true },
} as const;
const commands = catalogOf({
  assign: { target: 'application' },
  review: { target: 'application' },
  decide: { target: 'application' },
  receive: { target: 'document' },
  apply: { target: 'application', targets: 'none' },
});
const schema = {
  tables: [
    {
      id: 'application',
      name: 'application',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: 'status', type: 'TEXT', primaryKey: false, nullable: false },
        { name: 'note', type: 'TEXT', primaryKey: false, nullable: true },
        { name: 'moved_at', type: 'TIMESTAMP', primaryKey: false, nullable: true },
        { name: 'amount', type: 'INTEGER', primaryKey: false, nullable: true },
      ],
    },
    {
      id: 'document',
      name: 'document',
      schema: '',
      isView: false,
      columns: [{ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }],
    },
  ],
  foreignKeys: [],
} as unknown as DatabaseSchema;
const app = (resource: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Lending',
      resources: { application: { access: 'write', ...resource } },
      views: { applications: { kind: 'list', from: 'application' } },
      home: 'applications',
      ...extra,
    },
    'app.ts',
    { commands },
  );

test("a machine's verbs are the record's actions in the graph's order, from the states that list them, exits last", () => {
  const parsed = app({ machine: machine('status', states), actions: { flag: { label: 'Flag', set: { amount: 0 } } } });
  const actions = parsed.resources!.application.actions!;
  assert.deepEqual(
    actions.map((action) => [action.label, action.when]),
    [
      ['Assign', 'status = submitted'],
      ['Review', 'status in (in_review, documents)'],
      ['Decide', 'status = manager_review'],
      // Withdraw only ever leaves the road for a final state: an exit, drawn after the verbs that move the record on.
      ['Withdraw', 'status in (submitted, in_review, documents, manager_review)'],
      // An authored action that does not move the state follows the machine's.
      ['Flag', undefined],
    ],
  );
  assert.equal(actions[0].command?.id, 'assign');
  assert.deepEqual(actions[3].command, undefined);
  assert.deepEqual((actions[3] as { set: unknown }).set, { status: 'withdrawn' });
  assert.equal((actions[3] as { reason?: string }).reason, 'note');
});

test("the road is each state's first verb's first state, and a board over the column has its lanes", () => {
  const def = parseMachine(machine('status', states), 'm', (name) => commands.has(name));
  assert.deepEqual(machinePath(def), ['submitted', 'in_review', 'manager_review', 'approved']);
  const parsed = app(
    { machine: machine('status', states), display: { status: { values: { manager_review: 'With a manager' } } } },
    {
      views: { board: { kind: 'list', from: 'application', board: { by: 'status', primary: 'status' } } },
      home: 'board',
    },
  );
  const board = parsed.views.board as { presentation: { lanes?: string[] } };
  // The road, then the open states off it; the exits are not lanes.
  assert.deepEqual(board.presentation.lanes, ['submitted', 'in_review', 'manager_review', 'approved', 'documents']);
  assert.equal(resolveViews(parsed, schema).board.error, undefined);
  // Served, the machine says its states in the column's words.
  const served = resolveResources(parsed, schema).resources.application.machine!;
  assert.deepEqual(served.path, ['submitted', 'in_review', 'manager_review', 'approved']);
  assert.equal(served.states.find((state) => state.value === 'manager_review')?.label, 'With a manager');
  assert.equal(served.states.find((state) => state.value === 'in_review')?.label, 'In review');
});

test('a page over the resource draws the road as a stepper on its summary, and the page validates it', () => {
  const def = parseMachine(machine('status', states), 'm', (name) => commands.has(name));
  const page = {
    id: 'application',
    name: 'Application',
    base: 'application',
    sections: [
      { kind: 'fields', show: ['amount'], presentation: 'summary' },
      { kind: 'fields', show: ['note'] },
    ],
  } as unknown as PageDef;
  const [stepped] = withMachineSteppers([page], (base) =>
    base === 'application' ? { machine: def, words: { manager_review: 'With a manager' } } : undefined,
  );
  const workflow = (stepped.sections[0] as { workflow?: { field: string; steps: { value: string; label: string }[]; ordered: boolean } })
    .workflow;
  assert.deepEqual(workflow, {
    field: 'status',
    ordered: true,
    steps: [
      { value: 'submitted', label: 'Submitted' },
      { value: 'in_review', label: 'In review' },
      { value: 'manager_review', label: 'With a manager' },
      { value: 'approved', label: 'Approved' },
    ],
  });
  assert.equal((stepped.sections[1] as { workflow?: unknown }).workflow, undefined);
  assert.equal(validatePage(schema, stepped).error, undefined);
});

test("another record's command, and a form's, are edges of the graph and not buttons here", () => {
  const parsed = app({
    machine: machine('status', {
      draft: { on: { apply: 'submitted' } },
      submitted: { on: { receive: ['approved'], assign: 'approved' } },
      approved: { final: true },
    }),
  });
  assert.deepEqual(
    parsed.resources!.application.actions!.map((action) => action.label),
    ['Assign'],
  );
});

test('a public form can run a machine verb without granting it to a signed-in role', () => {
  const parsed = parseAppConfig(
    {
      name: 'Lending',
      resources: {
        application: {
          access: 'write',
          machine: machine('status', {
            draft: { on: { apply: 'submitted' } },
            submitted: { final: true },
          }),
        },
      },
      auth: { roles: { staff: { read: true } } },
      views: {
        applications: { kind: 'list', from: 'application' },
        apply: { kind: 'form', label: 'Apply', public: true, command: 'apply' },
      },
      home: 'applications',
    },
    'app.ts',
    { commands: catalogOf({ apply: { target: 'application', targets: 'none', public: true, input: { name: { type: 'text' } } } }) },
  );
  assert.deepEqual(machineChecks(parsed, schema), []);
  delete parsed.views.apply;
  assert.match(machineChecks(parsed, schema).join('\n'), /machine-verb-unrunnable/);
});

test('a reader whose catalog leaves out a table is not judged on verbs no one there can run', () => {
  const parsed = parseAppConfig(
    {
      name: 'Lending',
      resources: {
        application: {
          access: 'write',
          machine: machine('status', { draft: { on: { submit: 'submitted' } }, submitted: { final: true } }),
        },
        document: { access: 'write' },
      },
      auth: { roles: { clerk: { read: ['application'], write: ['application'] }, archivist: { read: ['document'] } } },
      views: { applications: { kind: 'list', from: 'application' } },
      home: 'applications',
    },
    'app.ts',
  );
  assert.deepEqual(machineChecks(parsed, schema), []);
  // The clerk's own catalog: the payload built for it reads no document, and judging grants there used to throw.
  const clerks = { ...schema, tables: schema.tables.filter((table) => table.id === 'application') } as DatabaseSchema;
  assert.deepEqual(machineChecks(parsed, clerks), []);
});

test('a machine refuses what it cannot mean, naming the fix', () => {
  const refused: Array<[unknown, RegExp]> = [
    [{ column: 'status', states: { a: { on: { go: 'nowhere' } } } }, /goes to "nowhere", which is not one of the states/],
    [{ column: 'status', states: { a: { final: true, on: { go: 'a' } } } }, /is final, so no verb leaves it/],
    [
      { column: 'status', states: { a: { on: { go: ['b', 'c'] } }, b: { final: true }, c: { final: true } } },
      /a fixed move sets one state/,
    ],
    [
      { column: 'status', states: { a: { final: true }, b: { on: { go: 'a' } } } },
      /is the first state, where a new record starts, and it is final/,
    ],
    [
      { column: 'status', states: { a: { on: { assign: { to: 'b', set: { amount: 1 } } } }, b: { final: true } } },
      /runs the command "assign".*"set" is a fixed move's/,
    ],
    [{ column: 'status', states: { a: { on: { go: { to: 'b', set: { status: 'b' } } } }, b: { final: true } } }, /sets "status" itself/],
    [{ column: 'status', states: { a: { on: { go: 'b' } }, b: { on: { go: 'a' } } } }, /the fixed verb "go" moves to different states/],
    [
      { column: 'status', states: { a: { after: { soon: 'assign' } } } },
      /say how long as a whole number and seconds, minutes, hours, days or weeks/,
    ],
    [
      { column: 'status', states: { a: { after: { '3 days': 'expire' } } } },
      /"expire", which is not one of the App's commands. A timer runs a command/,
    ],
    [
      { column: 'status', states: { a: { after: { '3 days': 'assign' }, on: { finish: 'done' } }, done: { final: true } } },
      /timer "assign" needs an on edge/,
    ],
    [{ column: 'status', states: { a: { colour: 'red' } } }, /has no "colour". A state takes on, after, by and final/],
    [
      { column: 'status', states: { a: { at: { moved_at: 'assign' } } } },
      /has an "at": a timer at an instant is the resource's own, not a state's\. Say it on the resource with a when/,
    ],
    [{ column: 'status', states: { a: { by: { automation: 'nowhere' } }, b: { final: true } } }, /by "automation": name the other states/],
    [{ column: 'status', states: { a: { by: { automation: 'a' } }, b: { final: true } } }, /by "automation": name the other states/],
    [{ column: 'status', states: { a: { by: { automation: ['b', 'b'] } }, b: { final: true } } }, /names a state twice/],
  ];
  for (const [raw, message] of refused) assert.throws(() => app({ machine: raw }), message, JSON.stringify(raw));
  // An authored action may not move the state, nor run a verb the machine offers already.
  assert.throws(
    () => app({ machine: machine('status', states), actions: { approve: { label: 'Approve', set: { status: 'approved' } } } }),
    /action "Approve" sets "status", which the machine moves/,
  );
  assert.throws(
    () => app({ machine: machine('status', states), actions: { assign: { label: 'Assign it', command: 'assign' } } }),
    /runs "assign", a verb of the machine, which offers it already/,
  );
  assert.throws(
    () => app({ access: undefined, machine: machine('status', states) }),
    /a record that moves needs the resource's access 'write'/,
  );
});

test('a resource runs a command at an instant the record keeps, and a state takes moves only a service role makes (G70, G100, G127)', () => {
  const raw = machine('status', {
    open: { on: { assign: 'working' }, by: { automation: ['escalated'] } },
    working: { on: { finish: 'done' } },
    escalated: { on: { finish: 'done' } },
    done: { final: true },
  });
  const checked = catalogOf({ assign: { target: 'application' }, expire: { target: 'application' }, escalate: { target: 'application' } });
  const def = parseMachine(raw, 'm', (name) => checked.has(name));
  assert.deepEqual(def.states[0].by, [{ role: 'automation', to: ['escalated'] }]);
  // No verb reaches "escalated": the service's move keeps it from being named.
  assert.deepEqual(machineProblems(def, 'm'), []);
  assert.deepEqual(
    machineActions(def).map((action) => action.label),
    ['Assign', 'Finish'],
    'a service-only move draws no button',
  );
  const parsed = (auth: unknown, column = 'moved_at', when?: string) =>
    parseAppConfig(
      {
        name: 'Lending',
        resources: {
          application: {
            access: 'write',
            machine: raw,
            at: { [column]: { command: 'expire', when: when ?? "status = 'open'" } },
          },
        },
        views: { applications: { kind: 'list', from: 'application' } },
        home: 'applications',
        ...(auth ? { auth } : {}),
      },
      'app.ts',
      { commands: checked },
    );
  const service = { roles: { automation: { service: true, commands: ['escalate'] }, clerk: {} } };
  assert.deepEqual(appTransitionRules(parsed(service), schema).problems, []);
  assert.deepEqual(parsed(service).resources?.application.at, [{ column: 'moved_at', command: 'expire', when: "status = 'open'" }]);
  // The service's command judges and writes the state, and is no verb: its move is the state's `by`, so check does not ask for one.
  const escalate = {
    source: undefined, // the App's one source, unnamed
    target: 'application',
    when: 'status = open',
    handle: async ({ db }: { db: any }) => db.application.update({}, { status: 'escalated' }),
  };
  assert.deepEqual(machineCommandWarnings(parsed(service), { escalate } as never), []);
  assert.match(
    machineCommandWarnings(parsed({ roles: { automation: { service: true } } }), { escalate } as never).join(''),
    /machine-command-outside/,
  );
  // A status written to another table is that table's, and one in a read of its own is no write at all.
  const unserved = parsed({ roles: { automation: { service: true } } });
  const withPayment = { ...unserved, resources: { ...unserved.resources, payment: { access: 'write' } } } as typeof unserved;
  const ctx = { db: {} as any };
  const settle = {
    source: undefined,
    target: 'application',
    when: 'status = open',
    handle: async ({ db }: { db: any }) => {
      const open = await db.application.find({ status: 'open' });
      await ctx.db.payment.update(await db.payment.get(open.payment_id), { status: 'paid', note: `for ${open.id}` });
    },
  };
  assert.deepEqual(machineCommandWarnings(withPayment, { settle } as never), []);
  // Its own status written beside it is still named.
  const both = {
    ...settle,
    handle: async ({ db }: { db: any }) => {
      await db.payment.update({}, { status: 'paid' });
      await db.application.update({}, { status: 'escalated' });
    },
  };
  assert.match(machineCommandWarnings(withPayment, { both } as never).join(''), /command "both" judges "status" of "application"/);
  assert.match(
    appTransitionRules(parsed({ roles: { automation: {} } }), schema).problems.join('\n'),
    /is moved by "automation", which is not a role with service: true/,
  );
  assert.match(
    appTransitionRules(parsed(service, 'note'), schema).problems.join('\n'),
    /at "note" runs "expire", and "note" is not a date or timestamp column of application/,
  );
  // A when is the record's own conditions, read as the sweep reads it.
  assert.match(appTransitionRules(parsed(service, 'moved_at', 'colour = red'), schema).problems.join('\n'), /at "moved_at", when: /);
  assert.match(
    appTransitionRules(parsed(service, 'moved_at', "status = 'open' sort note"), schema).problems.join('\n'),
    /a timer's when is a condition alone/,
  );
  // A timer names one of the App's commands, and a column by name, with command and when only.
  const resourceAt = (at: unknown) => () =>
    parseAppConfig(
      {
        name: 'Lending',
        resources: { application: { access: 'write', at } },
        views: { applications: { kind: 'list', from: 'application' } },
        home: 'applications',
      },
      'app.ts',
      { commands: checked },
    );
  assert.throws(resourceAt({ moved_at: 'expier' }), /"at" "moved_at" runs "expier", which is not one of the App's commands/);
  assert.throws(resourceAt({ 'moved at': 'expire' }), /"moved at": name a date or timestamp column/);
  assert.throws(resourceAt({ moved_at: { command: 'expire', every: 'day' } }), /has no "every". A timer takes command and when/);
  assert.throws(resourceAt({ moved_at: { command: 'expire', when: ' ' } }), /has a "when" that is not conditions/);
  assert.throws(resourceAt({}), /"at" is not \{ due_at: 'aCommand' \}/);
});

test('check names unreachable states and dead ends', () => {
  const def = parseMachine(
    {
      column: 'status',
      states: { open: { on: { close: 'closed' } }, stuck: { on: { close: 'closed' } }, parked: {}, closed: { final: true } },
    },
    'm',
    () => false,
  );
  const problems = machineProblems(def, 'resources "ticket", machine');
  assert.ok(
    problems.some((problem) => /"stuck" is unreachable.*\[machine-unreachable\]/.test(problem)),
    problems.join('\n'),
  );
  assert.ok(
    problems.some((problem) => /"parked" is a dead end.*\[machine-dead-end\]/.test(problem)),
    problems.join('\n'),
  );
  assert.deepEqual(
    machineProblems(
      parseMachine(machine('status', states), 'm', (name) => commands.has(name)),
      'm',
    ),
    [],
  );
  // A timer has an explicit edge from the state it waits in.
  const timed = parseMachine(
    {
      column: 'status',
      states: {
        open: { after: { '3 days': 'expire' }, on: { go: 'done', expire: 'expired' } },
        expired: { final: true },
        done: { final: true },
      },
    },
    'm',
    (name) => name === 'expire',
  );
  assert.deepEqual(machineProblems(timed, 'm'), []);
  assert.deepEqual(
    machineActions(timed).map((action) => action.label),
    ['Go', 'Expire'],
  );
});

test('typed machines: a verb to a state the machine lacks, and a timer naming no command, fail the typecheck', () => {
  const filename = new URL('./.app-machine-types.ts', import.meta.url).pathname;
  const source = `import { machine, defineApp, type TypedAppConfig, listView, queue } from '@mistriwork/mistri/app';
    declare module '@mistriwork/mistri/app' {
      interface Register { commands: { assign: { target: 'loan'; targets: 'one'; input: never }; expire: { target: 'loan'; targets: 'one'; input: never } } }
    }
    const good = machine('status', {
      open: { on: { assign: 'working', expire: 'dropped', drop: { to: 'dropped', reason: 'note' } }, after: { '3 days': 'expire' } },
      working: { on: { finish: ['done'] } },
      done: { final: true }, dropped: { final: true },
    });
    // @ts-expect-error A verb goes to a state the machine does not declare.
    machine('status', { open: { on: { go: 'nowhere' } }, done: { final: true } });
    // @ts-expect-error A timer runs one of the App's commands, by name.
    machine('status', { open: { after: { '3 days': 'expier' }, on: { go: 'done' } }, done: { final: true } });
    machine('status', { open: { by: { automation: 'done' }, on: { go: 'done' } }, done: { final: true } });
    // @ts-expect-error A timer at an instant is the resource's, not a state's.
    machine('status', { open: { at: { due_at: 'expire' }, on: { go: 'done' } }, done: { final: true } });
    // @ts-expect-error A service's move goes to one of the states.
    machine('status', { open: { by: { automation: 'nowhere' }, on: { go: 'done' } }, done: { final: true } });
    type App = TypedAppConfig<{ loan: 'id' | 'status' | 'note' }>;
    const app: App = { name: 'Loans', views: { loans: listView('Loan', 'loan') }, home: 'loans', resources: { loan: { access: 'write', machine: good } } };
    defineApp({ name: 'Loans', resources: { loan: { machine: good } }, views: { loans: listView('Loan', 'loan', { presentation: queue('id'), actions: ['assign', 'drop'] }) }, home: 'loans' });
    defineApp({ name: 'Loans', resources: { loan: { machine: good, at: { due_at: 'expire', warned_at: { command: 'expire', when: "status = 'open'" } } } }, views: { loans: listView('Loan', 'loan') }, home: 'loans' });
    // @ts-expect-error A resource's timer runs one of the App's commands, by name.
    defineApp({ name: 'Loans', resources: { loan: { at: { due_at: 'expier' } } }, views: { loans: listView('Loan', 'loan') }, home: 'loans' });
    // @ts-expect-error Selectors use the machine verb key, not its display label.
    defineApp({ name: 'Loans', resources: { loan: { machine: good } }, views: { loans: listView('Loan', 'loan', { presentation: queue('id'), actions: ['Drop'] }) }, home: 'loans' });
    void app;
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});

test("a board over a machine draws no lane its view's query (or its section's) can never hold", () => {
  const parsed = app(
    { machine: machine('status', states) },
    {
      views: {
        board: { kind: 'list', from: 'application', query: 'status != approved', board: { by: 'status', primary: 'status' } },
        open: { kind: 'list', from: 'application', query: 'status in (submitted, in_review)', board: { by: 'status', primary: 'status' } },
        either: {
          kind: 'list',
          from: 'application',
          query: 'status = submitted or amount > 10',
          board: { by: 'status', primary: 'status' },
        },
      },
      home: 'board',
    },
  );
  const lanes = (key: string) => (parsed.views[key] as { presentation: { lanes?: string[] } }).presentation.lanes;
  assert.deepEqual(lanes('board'), ['submitted', 'in_review', 'manager_review', 'documents']);
  assert.deepEqual(lanes('open'), ['submitted', 'in_review']);
  // A condition on another column may admit any state: every lane stays.
  assert.deepEqual(lanes('either'), ['submitted', 'in_review', 'manager_review', 'approved', 'documents']);
});

test("a command verb says {to} in its state's words, differently from different states, and carries each step for a board (G62)", () => {
  const advanced = {
    submitted: { on: { assign: { to: 'in_review', label: 'Move to {to}' }, withdraw } },
    in_review: { on: { assign: { to: 'manager_review', label: 'Move to {to}' }, withdraw } },
    manager_review: { on: { decide: ['approved', 'declined'], withdraw } },
    approved: { final: true },
    declined: { final: true },
    withdrawn: { final: true },
  } as const;
  const parsed = app({ machine: machine('status', advanced), display: { status: { values: { in_review: 'Review' } } } });
  const assign = parsed.resources!.application.actions!.find((action) => action.id === 'assign') as {
    label: string;
    labels?: unknown;
    move?: unknown;
  };
  assert.equal(assign.label, 'Move to Review');
  assert.deepEqual(assign.labels, [
    { when: 'status = submitted', label: 'Move to Review' },
    { when: 'status = in_review', label: 'Move to Manager review' },
  ]);
  // A different lane from each state: each step, so a board offers the one the card's state leads to.
  assert.deepEqual(assign.move, {
    column: 'status',
    edges: [
      { from: 'submitted', to: 'in_review' },
      { from: 'in_review', to: 'manager_review' },
    ],
  });
  // Several ends from one state: a board offers them where the command is told the column.
  const decide = parsed.resources!.application.actions!.find((action) => action.id === 'decide') as { move?: unknown };
  assert.deepEqual(decide.move, {
    column: 'status',
    edges: [
      { from: 'manager_review', to: 'approved' },
      { from: 'manager_review', to: 'declined' },
    ],
  });
  const one = app({ machine: machine('status', states) }).resources!.application.actions!.find((action) => action.id === 'assign');
  assert.deepEqual((one as { move?: unknown }).move, { column: 'status', edges: [{ from: 'submitted', to: 'in_review' }] });
  assert.throws(
    () =>
      app({
        machine: machine('status', { ...states, manager_review: { on: { decide: { to: ['approved', 'declined'], label: 'To {to}' } } } }),
      }),
    /says "\{to\}" in its label and goes to approved or declined/,
  );
});

test("a machine's entry states are states, said once, and count as reached", () => {
  const def = parseMachine(machine('status', states, { entry: ['in_review'] }), 'm', (name) => commands.has(name));
  assert.deepEqual(def.entry, ['in_review']);
  assert.throws(
    () => parseMachine(machine('status', states, { entry: ['nowhere' as never] }), 'm', (name) => commands.has(name)),
    /"nowhere", which is not one/,
  );
  assert.throws(
    () => parseMachine(machine('status', states, { entry: ['in_review', 'in_review'] }), 'm', (name) => commands.has(name)),
    /twice/,
  );
});

test('a command verb that asks nothing may ask before it runs, and one with inputs is refused the confirmation (R5)', () => {
  const asking = {
    ...states,
    manager_review: { on: { decide: { to: ['approved', 'declined'], confirm: true }, withdraw } },
  } as const;
  const actions = app({ machine: machine('status', asking) }).resources!.application.actions!;
  const decide = actions.find((action) => action.id === 'decide')!;
  assert.equal(decide.command?.id, 'decide');
  assert.equal((decide as { confirm?: boolean }).confirm, true);
  // A verb that does not say so runs on one click, as before.
  assert.equal((actions.find((action) => action.id === 'assign') as { confirm?: boolean }).confirm, undefined);
  // A command with inputs asks them in its form, which is already the question.
  const withInput = catalogOf({
    assign: { target: 'application' },
    review: { target: 'application' },
    decide: { target: 'application', input: { note: { type: 'text' } } },
  });
  assert.throws(
    () =>
      parseAppConfig(
        {
          name: 'Lending',
          resources: { application: { access: 'write', machine: machine('status', asking) } },
          views: { applications: { kind: 'list', from: 'application' } },
          home: 'applications',
        },
        'app.ts',
        { commands: withInput },
      ),
    /confirms, but its command "decide" asks for input in its form/,
  );
});
