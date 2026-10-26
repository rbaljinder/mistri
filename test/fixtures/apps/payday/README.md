# Payday

Payday is a fictional, single-company HR and payroll workspace inspired by the calm, friendly flows of [Gusto](https://gusto.com/product/hr/hris-system). It uses a local SQLite database and synthetic figures. It does not connect to payments, tax filing, benefits carriers or banks, and it calculates nothing: every total is written once by the seed, where a run's totals are the sum of its statements and a statement's net pay is its gross less the lines above it.

## What it demonstrates

- **Today** reads like a to-do list: the next payroll with its run-by and pay dates, time off requests and timesheets waiting on a decision, and a side column of who starts soon, open onboarding tasks, documents awaiting signature and what is coming up (anniversaries, first days, holidays).
- **People**: a directory of cards, departments with headcount and salary totals, onboarding tasks and a company calendar. A person's page keeps title, department and status above Overview (details, manager, and direct reports where they have any), Job & pay, Pay (their statements, totalled), Time off (balances and requests), Benefits, Documents and Onboarding tabs.
- **Payroll**: runs from January to September with tabs by stage, a payroll calendar of each run across its pay period with its pay date, every pay statement, and a run page with its totals, pay period and approval. A pay statement breaks gross pay into earnings, taxes withheld and deductions. Its **Payslip**, in the statement's More menu, is the same statement on paper (`document()` in `features/payroll.ts`), printed by the browser and saved as a PDF from its print dialog.
- **Time off**: requests, a “Who’s out” calendar of each request from its first day to its last, balances per person and policy (accrued, used, available, with the requests against each) and the four policies. Approving a request spends its hours from the teammate's balance in the same transaction and is refused, saying what is left, when the balance cannot cover it; declining keeps the reason on the request.
- **Time tracking**: weekly timesheets for the two hourly teammates, with the days behind each week. Several submitted timesheets approve together from the queue.
- **Benefits**: a dashboard of plans with employee and company monthly cost, enrollments by plan, medical coverage tiers and elections still waiting; plan and enrollment pages.
- **Documents**: offer letters, tax forms, direct deposit authorizations and the 2026 handbook acknowledgment, with the ones awaiting signature first. A reminder is recorded, not sent.
- **Languages**: the people screens' captions are messages, from `messages/en.ts` and `messages/es.ts`. Payday is served in English (`ui.locale: 'en-US'`); a reader whose language the App names, by their row's `ui.locale` column or their tenant's, reads them in Spanish at the same addresses ([Languages](../../../site/src/content/docs/docs/languages.md)).
- **Reports**: payroll cost by month, headcount by department, time off by policy and by month, and the open signature and onboarding items.

These screens use shared building blocks through the App DSL: dashboards with metric (each opening its list), chart, breakdown, matrix, rows and embedded queue sections, the aside's rows drawn as names; compact queue, card and calendar (with ranges) list presentations; record pages with facts, property rails, tabs, related lists (hidden while empty, totalled, matched on two keys) and page metrics. One screen is Payday's own: a payroll run's **Pay history** is a [custom component](../../../site/src/content/docs/docs/custom-components.md) (`widgets/PayrollTimeline.tsx`) that places every run's pay period on a month axis, the run in hand marked, and becomes a list on a phone. Its rows are a declared read, planned and authorized like a related list; it draws with `@mistriwork/mistri/ui` and the looks' tokens, and is tested with `@mistriwork/mistri/ui/testing` (`npx vitest run test/fixtures/apps/payday`). Serving it from source needs Rolldown, which a checkout has.

## First journeys

1. **Run payroll.** From Today, open **September 16–30 payroll**, submit it for review, then approve it with a note.
2. **Answer a time off request.** Open Jordan Brooks's vacation request from Today and approve it; the request page shows Jordan's balances, and the vacation balance drops by 40 hours. Quinn Davis's personal-day request is more than Quinn's balance holds: approving it is refused with how many hours Quinn has left, and declining it asks for a reason.
3. **Approve timesheets.** From Today, open **Timesheets to approve**, select two weeks and approve them together.
4. **Chase a signature.** Open **Documents**, pick a handbook acknowledgment awaiting signature and send a reminder.

## Setup

Choose a new database path. Before starting the server, configure the native
authentication secret and create an invited account as described below.

```sh
node --import tsx test/fixtures/databases/payday/seed.mjs /tmp/payday.db
npx tsc -p test/fixtures/apps/payday/tsconfig.json
npx tsx packages/mistri/src/server/index.ts check --config /tmp/payday.db.json --app test/fixtures/apps/payday
npx tsx packages/mistri/src/server/index.ts --config /tmp/payday.db.json --app test/fixtures/apps/payday --port 4738
```

The seed applies the schema from `test/fixtures/databases/payday/migrations/` first, the way
`tablewalk migrate up` does, and `/tmp/payday.db.json` names that directory:
`npx tsx packages/mistri/src/server/index.ts migrate status --config /tmp/payday.db.json`.

The seed is dated around September 2026: Today's “Coming up” list and the “Upcoming” time off tab read from the real date, so on a later date they may be empty.

## Module map

| Module | What it holds |
| --- | --- |
| `app.ts` | Today, its task queues, resource ceilings, roles, navigation and the shell. |
| `people.ts` | People, departments, onboarding, the company calendar and the person page. |
| `features/payroll.ts` | Pay runs, pay statements, the payroll calendar, the run page's pay history, and the submit and approve actions with their grants. |
| `components.ts` | The declared custom component, `payrollTimeline`. |
| `widgets/` | Its module, stylesheet and test. |
| `features/timeoff.ts` | Requests, balances, policies, “Who’s out”, the approve command reference and the decline action. |
| `features/time.ts` | Timesheets, their days and the bulk approve action. |
| `features/benefits.ts` | Plans, enrollments and the benefits dashboard. |
| `features/documents.ts` | Documents and the reminder action. |
| `features/reports.ts` | The Reports dashboard. |
| `features/company.ts` | The company profile, a settings record. |
| `commands.ts` | The one server-side handler: approving time off. |
| `theme.ts` | The Payday look. |
| `messages/` | The people screens' words: `en.ts` (the source, in `ui.locale`'s language) and `es.ts`, said by `msg('people.…')`. |

## Native auth bootstrap

Payday uses invited native email accounts. Set `BETTER_AUTH_SECRET` to a private
random value of at least 32 characters, and retain it across server restarts.
Set `PAYDAY_PASSWORD` for the account you are creating. After seeding, run the
public maintenance helper once from a small local script in the checkout
(never commit passwords):

```ts
import { createAppAccounts } from '@mistriwork/mistri/maintenance';
await createAppAccounts('test/fixtures/apps/payday', [
  { email: 'payroll@example.test', name: 'Payroll Manager', password: process.env.PAYDAY_PASSWORD! },
]);
```

The account receives the App's default `payroll_manager` role.

The payroll manager writes no table. It runs payroll, answers time off, approves timesheets and sends reminders through actions granted to it by name, and cannot edit an employee record or a run's figures. To bootstrap an administrator,
set `MISTRI_AUTH_ADMIN_EMAIL` and `MISTRI_AUTH_ADMIN_PASSWORD` on the first
server start. The administrator edits employees and the **Company profile**
(under Settings in the account menu), and adds accounts and sets their roles
under **Manage accounts**. Keep authentication state and mutable databases
outside the watched App directory.

Submitting and approving a run, declining a request, approving timesheets and
sending a reminder only set a status and stamp who and when (`me`, `now`),
so they are fixed actions, granted to the payroll manager in `auth.roles`
(`actions: { pay_run: ['Submit for review', 'Approve payroll'] }`,
[granting a fixed action](../../../site/src/content/docs/docs/commands.md#grant-a-fixed-action-without-write)).
The server admits each as exactly that action: its status, its stamps and its
reason, judged against the record's current state, and nothing else. Approving
time off stays a command in `commands.ts`, because it also spends the
teammate's balance in the same transaction.

## Tests

`e2e/payday.spec.ts` covers the payroll journey (source and built), the phone menu and language switching; `e2e/payday-work.spec.ts` covers bulk timesheet approval, the refused and declined time off request, the reminder and the person page at desktop and phone widths. Run them with `npm run e2e -- e2e/payday.spec.ts e2e/payday-work.spec.ts`.

## Known limits

- The seed writes every figure; nothing recalculates a run, a statement or an accrual when data changes.
- An approver is recorded by the account's email, not by name.
