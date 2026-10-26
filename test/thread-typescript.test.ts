import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { typecheck } from './support/tsc.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appProblems, loadApp } from '../packages/mistri/src/server/app/apps.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
import { appCeilingWarnings, withRollups } from '../packages/mistri/src/shared/app.js';

const appDirectory = resolve('test/fixtures/apps/thread');

// Captured before the JSON-to-TS migration, then explicitly updated for editable
// issue modals, again for the triage queue and cycle board, and again when the
// Workspace gained its two metric cards with windows and the issue page its
// workflow strip and aside summary, again when Updates became the split
// list, and again when Inbox joined Issues as a split keyed by its entry id.
// Updated again for the one-vocabulary DSL, whose lowering names each list entry by its
// view key, nests groups as ancestors, marks the home dashboard, carries a
// resource's actions and New form on every view over it, and keys pages
// without the config- prefix. Updated again when views, nav and resources
// took their own shape: list views keyed by id in their own words (show,
// presentation as primary and lines), nav kept as the tree it was written
// as, and captions, actions and forms left on the resource. Updated again when
// the server began resolving the home per visitor: the home rules are kept as
// written, and no view says it is the home.
// Updated again (0.8.0) when a label became addressed by its name
// (`address: 'name'`, /thread/label/bug).
// Updated for 0.8.2 machine-derived action arrays and workflow metadata.
// Updated for 0.9.0: the stepper sits on the first main-column fields(), which
// is a summary unless it says otherwise; the aside's fields are a property rail.
// Keep independent of authoring so accidental contract drift shows.
const originalContract = {
  app: {
    id: 'thread',
    name: 'Thread',
    resources: {
      issue: {
        access: 'write',
        favorite: true,
        display: {
          description: { format: 'richText', images: 'attachment', mentions: { from: 'member', by: 'id', labelColumn: 'name' } },
          status: {
            humanize: true,
            tone: {
              backlog: 'neutral',
              ready: 'neutral',
              in_progress: 'warn',
              in_review: 'info',
              done: 'good',
              canceled: 'neutral',
            },
          },
          priority: {
            humanize: true,
            tone: {
              urgent: 'bad',
              high: 'neutral',
              normal: 'neutral',
              low: 'neutral',
            },
          },
        },
        segments: {
          active: {
            label: 'Active',
            query: 'status != done and status != canceled',
          },
          backlog_issues: {
            label: 'Backlog',
            query: 'status = backlog',
          },
          done_issues: {
            label: 'Done',
            query: 'status = done',
          },
          current_cycle: {
            label: 'Current cycle',
            query: 'cycle_id = 1 and status != canceled',
          },
        },
        form: {
          show: ['name', 'description', 'priority', 'assignee_id', 'project_id', 'cycle_id'],
        },
        machine: {
          column: 'status',
          states: [
            {
              name: 'backlog',
              label: 'Backlog',
            },
            {
              name: 'ready',
              label: 'Ready',
            },
            {
              name: 'in_progress',
              label: 'In progress',
            },
            {
              name: 'in_review',
              label: 'In review',
            },
            {
              name: 'done',
              label: 'Done',
              final: true,
            },
            {
              name: 'canceled',
              label: 'Canceled',
              final: true,
            },
          ],
          edges: [
            {
              verb: 'markReady',
              from: 'backlog',
              to: ['ready'],
              label: 'Mark ready',
              fixed: {
                set: {
                  status: 'ready',
                },
                bulk: true,
              },
            },
            {
              verb: 'cancelIssue',
              from: 'backlog',
              to: ['canceled'],
              label: 'Cancel issue',
              fixed: {
                set: {
                  status: 'canceled',
                },
                reason: 'cancel_note',
              },
            },
            {
              verb: 'startWork',
              from: 'ready',
              to: ['in_progress'],
              label: 'Start work',
              fixed: {
                set: {
                  status: 'in_progress',
                },
                bulk: true,
              },
            },
            {
              verb: 'cancelIssue',
              from: 'ready',
              to: ['canceled'],
              label: 'Cancel issue',
              fixed: {
                set: {
                  status: 'canceled',
                },
                reason: 'cancel_note',
              },
            },
            {
              verb: 'requestReview',
              from: 'in_progress',
              to: ['in_review'],
              label: 'Request review',
              fixed: {
                set: {
                  status: 'in_review',
                },
              },
            },
            {
              verb: 'cancelIssue',
              from: 'in_progress',
              to: ['canceled'],
              label: 'Cancel issue',
              fixed: {
                set: {
                  status: 'canceled',
                },
                reason: 'cancel_note',
              },
            },
            {
              verb: 'markDone',
              from: 'in_review',
              to: ['done'],
              label: 'Mark done',
              fixed: {
                set: {
                  status: 'done',
                },
              },
            },
            {
              verb: 'sendBack',
              from: 'in_review',
              to: ['in_progress'],
              label: 'Send back',
              fixed: {
                set: {
                  status: 'in_progress',
                },
              },
            },
            {
              verb: 'cancelIssue',
              from: 'in_review',
              to: ['canceled'],
              label: 'Cancel issue',
              fixed: {
                set: {
                  status: 'canceled',
                },
                reason: 'cancel_note',
              },
            },
          ],
        },
        actions: [
          {
            id: 'markReady',
            label: 'Mark ready',
            set: {
              status: 'ready',
            },
            when: 'status = backlog',
            bulk: true,
          },
          {
            id: 'startWork',
            label: 'Start work',
            set: {
              status: 'in_progress',
            },
            when: 'status = ready',
            bulk: true,
          },
          {
            id: 'requestReview',
            label: 'Request review',
            set: {
              status: 'in_review',
            },
            when: 'status = in_progress',
          },
          {
            id: 'markDone',
            label: 'Mark done',
            set: {
              status: 'done',
            },
            when: 'status = in_review',
          },
          {
            id: 'sendBack',
            label: 'Send back',
            set: {
              status: 'in_progress',
            },
            when: 'status = in_review',
          },
          {
            id: 'cancelIssue',
            label: 'Cancel issue',
            set: {
              status: 'canceled',
            },
            when: 'status in (backlog, ready, in_progress, in_review)',
            reason: 'cancel_note',
          },
        ],
        tags: {
          through: 'issue_label',
          to: 'label',
          toneOf: 'tone',
        },
        noun: {
          one: 'issue',
          many: 'issues',
        },
      },
      comment: {
        access: 'write',
        display: { body: { format: 'richText', mentions: { from: 'member', by: 'id', labelColumn: 'name' } } },
        form: {
          show: ['issue_id', 'author_id', 'name', 'body'],
        },
        noun: {
          one: 'update',
          many: 'updates',
        },
      },
      issue_label: {
        access: 'write',
        delete: true,
      },
      attachment: {
        access: 'write',
        delete: true,
        file: {
          content: 'data',
          name: 'file_name',
          type: 'content_type',
          size: 'byte_size',
        },
      },
      project: {
        display: {
          health: { format: 'rating', tone: { '<= 2': 'bad' } },
          status: {
            humanize: true,
            tone: {
              planned: 'neutral',
              active: 'info',
              complete: 'good',
            },
          },
        },
      },
      cycle: {},
      label: {
        address: 'name',
      },
      member: {},
    },
    views: {
      workspace: {
        label: 'Workspace',
        sections: [
          {
            kind: 'metric',
            title: 'Opened, last 30 days',
            table: 'issue',
            query: 'created_at = last 30 days',
            compare: 'previous period',
            spark: true,
            over: 'created_at',
            width: 'half',
          },
          {
            kind: 'metric',
            title: 'Closed, last 30 days',
            table: 'issue',
            query: 'status = done and created_at = last 30 days',
            compare: 'previous period',
            better: 'up',
            spark: true,
            over: 'created_at',
            width: 'half',
          },
          {
            kind: 'rows',
            title: 'Needs attention',
            table: 'issue',
            query: 'priority = urgent and status != done and status != canceled',
            show: ['name', 'status', 'assignee_id.name', 'project_id.name'],
            limit: 6,
          },
          {
            kind: 'board',
            title: 'Current cycle',
            table: 'issue',
            query: 'current_cycle',
            by: 'status',
            show: ['name', 'assignee_id.name', 'priority'],
            limit: 3,
            lanes: ['backlog', 'ready', 'in_progress', 'in_review', 'done'],
          },
          {
            kind: 'rows',
            title: 'Projects',
            table: 'project',
            limit: 6,
            view: 'projects',
            show: ['name', 'status', 'health', 'lead_id.name', 'target_on'],
          },
          {
            kind: 'rows',
            title: 'Cycles',
            table: 'cycle',
            limit: 3,
            view: 'cycles',
            show: ['name', 'starts_on', 'ends_on', 'goal'],
          },
        ],
        icon: 'house',
        windows: ['last 30 days', 'last 90 days'],
      },
      issues: {
        table: 'issue',
        icon: 'list-checks',
        show: ['name', 'status', 'priority', 'tags', 'assignee_id.name', 'project_id.name', 'cycle_id.name'],
        tabs: [
          {
            label: 'Active',
            query: 'active',
            segment: 'active',
            slug: 'active',
          },
          {
            label: 'Backlog',
            query: 'backlog_issues',
            segment: 'backlog_issues',
            slug: 'backlog_issues',
          },
          {
            label: 'Done',
            query: 'done_issues',
            segment: 'done_issues',
            slug: 'done_issues',
          },
          {
            label: 'All',
          },
        ],
        filters: ['name', 'status', 'priority', 'tags', 'assignee_id'],
        open: 'modal',
      },
      inbox: {
        table: 'issue',
        label: 'Inbox',
        icon: 'tray',
        show: ['name', 'status', 'assignee_id.name'],
        presentation: {
          kind: 'split',
          detail: ['name', 'status', 'priority', 'assignee_id.name', 'project_id.name', 'description'],
          limit: 25,
          row: {
            primary: 'name',
            lines: ['assignee_id.name'],
            facts: ['priority'],
            badge: 'status',
            avatar: 'assignee_id.name',
          },
        },
        keys: {
          m: 'markReady',
          s: 'startWork',
          r: 'requestReview',
          d: 'markDone',
        },
      },
      triage: {
        table: 'issue',
        label: 'Triage',
        icon: 'flag',
        query: 'status = backlog or status = ready',
        show: ['name', 'status', 'priority', 'assignee_id.name'],
        presentation: {
          kind: 'queue',
          primary: 'name',
          lines: ['status', 'priority'],
        },
        filters: ['priority', 'assignee_id'],
        open: 'modal',
      },
      board: {
        table: 'issue',
        label: 'Board',
        icon: 'kanban',
        query: 'current_cycle',
        presentation: {
          kind: 'board',
          by: 'status',
          order: 'rank',
          limits: {
            in_progress: 4,
            in_review: 2,
          },
          primary: 'name',
          lines: ['priority'],
          lanes: ['backlog', 'ready', 'in_progress', 'in_review', 'done'],
        },
        filterBar: 'none',
        open: 'modal',
      },
      planning: {
        table: 'issue',
        label: 'Planning',
        icon: 'calendar-check',
        query: 'status != canceled and status != done',
        show: ['name', 'status', 'priority'],
        presentation: {
          kind: 'board',
          by: 'cycle_id',
          order: 'rank',
          swimlanes: 'priority',
          primary: 'name',
          lines: ['status'],
        },
        filterBar: 'none',
        open: 'modal',
      },
      projects: {
        table: 'project',
        label: 'Projects',
        icon: 'folder',
        show: ['name', 'status', 'health', 'lead_id.name', 'target_on'],
      },
      cycles: {
        table: 'cycle',
        label: 'Cycles',
        icon: 'calendar',
        show: ['name', 'starts_on', 'ends_on', 'goal'],
      },
      updates: {
        table: 'comment',
        label: 'Updates',
        icon: 'chat-circle',
        show: ['name', 'issue_id.name', 'author_id.name'],
        presentation: {
          kind: 'split',
          detail: ['name', 'issue_id.name', 'author_id.name', 'created_at', 'body'],
          limit: 25,
        },
      },
      people: {
        table: 'member',
        label: 'People',
        icon: 'users',
        show: ['name', 'team', 'role'],
        open: 'drawer',
      },
    },
    nav: [
      {
        group: 'plan',
        label: 'Plan',
        children: [
          {
            view: 'workspace',
          },
          {
            view: 'issues',
          },
          {
            view: 'inbox',
          },
          {
            view: 'triage',
          },
          {
            view: 'board',
          },
          {
            view: 'planning',
          },
          {
            view: 'projects',
          },
          {
            view: 'cycles',
          },
        ],
      },
      {
        group: 'team',
        label: 'Team',
        children: [
          {
            view: 'updates',
          },
          {
            view: 'people',
          },
        ],
      },
    ],
    home: [
      {
        view: 'workspace',
      },
    ],
    ui: {
      logo: 'kanban',
      theme: {
        preset: 'lumen',
      },
      shell: {
        placement: 'side',
        rail: true,
      },
    },
  },
  pages: [
    {
      id: 'cycle',
      name: 'Cycle',
      base: 'cycle',
      defaultAside: true,
      sections: [
        {
          kind: 'fields',
          paths: ['starts_on', 'ends_on'],
        },
        {
          kind: 'fields',
          paths: ['goal'],
          columns: 1,
        },
        {
          kind: 'breakdown',
          title: 'Delivery status',
          width: 'half',
          from: 'issue',
          path: 'cycle_id',
          by: 'status',
        },
        {
          kind: 'list',
          title: 'Cycle issues',
          width: 'half',
          from: 'issue',
          path: 'cycle_id',
          columns: ['name', 'status', 'priority', 'assignee_id.name'],
        },
      ],
      source: 'config',
    },
    {
      id: 'issue',
      name: 'Issue',
      base: 'issue',
      defaultAside: true,
      sections: [
        {
          kind: 'fields',
          presentation: 'header',
          paths: [],
          headerActions: ['markReady', 'startWork', 'requestReview', 'markDone'],
        },
        {
          kind: 'fields',
          paths: ['name', 'assignee_id', 'project_id'],
          columns: 3,
          workflow: {
            field: 'status',
            steps: [
              {
                value: 'backlog',
                label: 'Backlog',
              },
              {
                value: 'ready',
                label: 'Ready',
              },
              {
                value: 'in_progress',
                label: 'In progress',
              },
              {
                value: 'in_review',
                label: 'In review',
              },
              {
                value: 'done',
                label: 'Done',
              },
            ],
            ordered: true,
          },
        },
        {
          kind: 'fields',
          title: 'Description',
          width: 'half',
          paths: ['description'],
        },
        {
          kind: 'timeline',
          title: 'Activity',
          streams: [
            {
              from: 'comment',
              path: 'issue_id',
              at: 'created_at',
              show: 'name',
              detail: 'body',
              by: 'author_id.name',
            },
          ],
          limit: 12,
          width: 'half',
          newest: 'last',
          create: {
            label: 'Add update',
            show: ['name', 'body', 'author_id'],
          },
        },
        {
          kind: 'fields',
          region: 'aside',
          paths: ['priority', 'cycle_id'],
          columns: 1,
          presentation: 'summary',
          edit: true,
        },
        {
          kind: 'list',
          title: 'Attachments',
          from: 'attachment',
          path: 'issue_id',
          columns: ['file_name', 'byte_size', 'added_at'],
          limit: 10,
          create: {
            label: 'Attach file',
          },
        },
        {
          kind: 'list',
          title: 'Project issues',
          from: 'issue',
          path: '',
          similar: { same: ['project_id'] },
          columns: ['name', 'status', 'priority', 'assignee_id.name'],
          limit: 8,
        },
      ],
      listTabs: false,
      source: 'config',
    },
    {
      id: 'project',
      name: 'Project',
      base: 'project',
      defaultAside: true,
      sections: [
        {
          kind: 'fields',
          paths: ['status', 'health', 'lead_id', 'target_on'],
        },
        {
          kind: 'fields',
          paths: ['summary'],
          columns: 1,
        },
        {
          kind: 'breakdown',
          title: 'Issue status',
          width: 'half',
          from: 'issue',
          path: 'project_id',
          by: 'status',
        },
        {
          kind: 'metric',
          title: 'Open issues',
          width: 'half',
          fn: 'count',
          from: 'issue',
          path: 'project_id',
          filter: 'status != done and status != canceled',
        },
        {
          kind: 'list',
          title: 'Issues',
          from: 'issue',
          path: 'project_id',
          columns: ['name', 'status', 'priority', 'assignee_id.name', 'cycle_id.name'],
        },
        {
          kind: 'list',
          title: 'Plan',
          from: 'issue',
          path: 'project_id',
          columns: ['name', 'status', 'priority'],
          limit: 6,
          orderBy: [{ column: 'rank', direction: 'asc' }],
          group: { by: 'cycle_id', show: ['starts_on', 'ends_on'], sort: { column: 'starts_on', direction: 'asc' }, empty: 'Unplanned' },
        },
      ],
      source: 'config',
    },
  ],
};

test('Thread: TypeScript preserves the complete reviewed normalized contract', async () => {
  const loaded = await loadApp(appDirectory);
  assert.equal(loaded.path, join(appDirectory, 'app.ts'));
  assert.deepEqual(JSON.parse(JSON.stringify({ app: loaded.app, pages: loaded.pages })), originalContract);
  assert.deepEqual(
    readdirSync(appDirectory, { recursive: true }).filter((file) => String(file).endsWith('.json')),
    ['tsconfig.json'],
    'Only compiler configuration may remain JSON; app and pages are TypeScript',
  );
});

test('Thread: disposable seed validates the app, reproduces types and refuses overwrites', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-thread-typescript-'));
  const file = join(directory, 'thread.db');
  const script = resolve('test/fixtures/databases/thread/seed.mjs');
  let adapter: SqliteAdapter | undefined;
  try {
    execFileSync(process.execPath, [script, file], { stdio: 'pipe' });
    adapter = new SqliteAdapter(file);
    const schema = await adapter.introspect();
    const loaded = await loadApp(appDirectory);
    assert.deepEqual(appProblems(loaded, schema), []);
    assert.deepEqual(appCeilingWarnings(loaded.app, schema), []);
    assert.equal(
      readFileSync(join(appDirectory, 'mistri-schema.d.ts'), 'utf8').trimEnd(),
      // The App's tags read like a column (tagLists.ts), as `mistri check` writes them.
      typesForSchema({ ...withRollups(loaded.app, schema), label: 'thread' }).trimEnd(),
      'Regenerate Thread types from a fresh seed after schema changes',
    );
    await adapter.close();
    adapter = undefined;

    const before = readFileSync(file);
    const configBefore = readFileSync(`${file}.json`);
    assert.throws(() => execFileSync(process.execPath, [script, file], { stdio: 'pipe' }), /Refusing to replace/);
    assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(readFileSync(`${file}.json`), configBefore);

    const reserved = join(directory, 'reserved.db');
    writeFileSync(`${reserved}.json`, 'keep', { flag: 'wx' });
    assert.throws(() => execFileSync(process.execPath, [script, reserved], { stdio: 'pipe' }), /Refusing to replace/);
    assert.equal(existsSync(reserved), false);
    assert.equal(readFileSync(`${reserved}.json`, 'utf8'), 'keep');
  } finally {
    await adapter?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Thread: strict authoring types check every module and reject schema typos', () => {
  const configFile = join(appDirectory, 'tsconfig.json');

  // A probe beside the sample's modules uses its actual package/type resolution;
  // it is on disk only for the length of the check, under a name nothing reads.
  const probeFile = join(appDirectory, `.authoring-probe-${process.pid}.ts`);
  const probe = `
import { defineApp, dashboard, listView, rows, page, related } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

export const valid = defineApp({
  name: 'Typed Thread',
  resources: { issue: { display: { status: { tone: { done: 'good' } } } } },
  views: { workspace: dashboard('Workspace', [rows('Issues', 'issue')]), people: listView('People', 'member') },
  pages: { issue: page('issue', [related('Discussion', 'comment', 'issue_id')]) },
  home: 'workspace',
  nav: ['workspace', 'people'],
} satisfies App);

// @ts-expect-error View tables come from the seeded schema.
export const badNavigation = { name: 'Bad', views: { issues: listView('Issues', 'isssue') }, home: 'issues', nav: ['issues'] } satisfies App;
// @ts-expect-error Dashboard constructors preserve their literal table names.
export const badDashboard = { name: 'Bad', views: { bad: dashboard('Bad', [rows('Bad', 'isssue')]) }, home: 'bad', nav: ['bad'] } satisfies App;
// @ts-expect-error Display keys check column names, too.
export const badDisplay = { issue: { display: { stauts: { tone: { done: 'good' } } } } } satisfies App['resources'];
// @ts-expect-error Page bases must name an existing table.
export const badPage = page('isssue', []) satisfies NonNullable<App['pages']>[string];
// @ts-expect-error Section constructors reject unsupported options.
export const badList = rows('Issues', 'issue', { compare: 'previous period' });
`;
  assert.equal(typecheck(probeFile, { files: { [probeFile]: probe }, project: configFile }), '');
});
