---
title: Composing a form
description: Rules of the form "when X, use Y" for a New form, a command form and a create from a parent's page, each with a worked example.
---

Rules of the form "when X, use Y" for a New form, a command form and a create from a parent's page, each with a worked example.

A form reads as designed when it says what it is for, asks in groups, fills
in what it can and explains what is not obvious. Tick's New task and
Lintel's Report a problem are the worked examples.

![Lintel's Report a problem, as a resident: a sentence of purpose, what's wrong with its help, the kind of problem, more detail, two checkboxes and Send report.](../../../assets/guide/form.webp)

- **Always**, give the form a `description`: one sentence of what a new
  record is for — `examples/apps/lintel/views.ts:39`.
- **When it asks for six or more fields**, use `groups` of 3–7 fields under
  nouns (Person, Lead), not types (Dates, Links), as the
  [Forms](/docs/forms/) options show.
- **When a required field has an obvious value**, put it in `defaults`:
  the first state where the column has no DEFAULT, `today` on a created-on date, `now` on a timestamp,
  `me` on an owner (constants from `@mistriwork/mistri/app`) — `examples/apps/lintel/resources.ts:305`.
- **When a field is not obvious, or is optional**, give it `help` that
  says what to put there or what leaving it empty does, and a `placeholder`
  for its shape — `examples/apps/lintel/commands/maintenance.ts:39`. The
  form already says "(optional)" beside the label; the help never says it again.
- **When two or three short fields are read together** (what came and how
  many, a day and a time), make them a row: `show: [['part_id', 'quantity'], …]`,
  up to three to a row, the same in a group's `fields` and a step —
  `examples/apps/lintel/resources.ts:334`.
- **When a reference's choices belong to another field's choice** (a task's
  deal is one of its account's), narrow it with `where`.
- **When two fields must agree**, say it as `validation` with a sentence,
  beside the form — `examples/apps/lintel/resources.ts:78`.
- **When a child is added from its parent's page**, give the related list a
  `create` with the few fields it needs and `prefill` for the references the
  parent already knows — `examples/apps/lintel/pages/maintenance_request.ts:30`.
- **When the form decides something against stored state, runs in steps, or
  is filled all day**, make it a `commandForm` with `step`s and
  `field.*({ help })` — `examples/apps/lintel/views.ts:220`,
  `examples/apps/lintel/commands/maintenance.ts:37`.
- **When it is a long application, public or not**, give it `style: 'intake'`:
  one question a step, the step's `title`, `lead` and `next`, a `note` of
  reassurance and a review before submitting —
  `examples/apps/lintel/views.ts:229`.

Text named like prose (`notes`, `description`) is a box of several lines on
its own; `fields.<name>.multiline` says so for any other. The keys are in
[Forms](/docs/forms/).

## Related

- [Forms](/docs/forms/): the keys behind every rule above.
- [Command forms](/docs/command-forms/): guided, public and stepped forms.
- [Display rules](/docs/vocabularies/): the words and tones inputs share.
