# Before you hand back

A rubric pass on every page is not a finished App: it also has what its domain expects beyond the pages.
Go through each item. Build it, or say in the report why the domain has no need of it; an item left out
without a word is not finished.

- **Notifications on the machine's edges**: a move someone waits on (approved, ready, shipped) tells
  them through the resource's `notify` (`on: { changes: 'status' }`, `when`, `to`, `title`); its inbox store
  comes from `npx @mistriwork/mistri migrate stores up --app .` (`mistri docs actions`, `mistri docs email`).
- **A document where the domain has paper**: an invoice, receipt, quote, packing slip or payslip is a
  `document()` printed from the record page (`mistri docs documents`).
- **A customer-facing side where customers interact**: a booking or request is a command form with
  `public: true` over a `public: true` command, served at `/form/<key>` (`mistri docs command-forms`);
  a page they check on is read through `auth.public`, or a customer role with `rows: 'policy'`
  ([choices.md](choices.md)).
- **History**: `history()` in the record page's aside, its store provisioned by
  `npx @mistriwork/mistri migrate stores up --app .` (`mistri docs pages`).
- **Search**: each resource people look up has a `recordLabel`, so a list's search, the pickers and ⌘K
  find it by name; `resources.*.search` only for a search index (`mistri docs dsl-resources`).
- **Seed data**: `npx @mistriwork/mistri seed --app . --config ../mistri.json` (`--rows <n>` for more); a seed
  script beside the database (never in the App's folder) only for rows it cannot make: real names, per-table
  counts, status-consistent rows, the emails a row policy matches.
- **Tests**: `npx @mistriwork/mistri test init .`, then `node --test 'tests/*.test.ts'` green, plus the App's
  own journeys ([testing.md](testing.md)).
- **Design**: `npx @mistriwork/mistri check --app . --design --fix`, then `check --design` with no warning left;
  `check --defaults` shows what the platform already infers, so nothing is restated.
- **Grade**: `npx @mistriwork/mistri grade . --config ../mistri.json` reports nothing to fix.
- **Seen dark and on a phone**: `npx @mistriwork/mistri shot --app . --dark` and `npx @mistriwork/mistri shot --app . --phone`,
  each picture read; with a theme of its own, `theme show <id> --app . --diff <base>` says how far it stands from
  its base ([design-language.md](design-language.md)).

Report each item with the command you ran and its exit code, or the reason it does not apply.
