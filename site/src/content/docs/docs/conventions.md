---
title: Conventions
description: What an App draws without being told, read off a column's name, type and vocabulary, and how to overrule it.
keywords: [conventions, defaults, inferred, money, tones, due date, check --defaults, restated]
---

What an App draws without being told, read off a column's name, type and vocabulary, and how to overrule it.

```sh
mistri check --app examples/apps/lintel --defaults
```

## What you'll see

`--defaults` prints each resource's columns with the rule the platform gives each one and why ("a number named like money"), each page's layout and why, and says where the App's own rule wins.

| The column | Is drawn as |
|---|---|
| A number named like money (`price`, `total`, `fee`, `balance`, `hourly_rate`), or a `money` column | money in the App's currency |
| A number named like a percentage (`probability`, `progress`, `_rate`) | a percent with a bar |
| A date named like a due date (`due_on`, `deadline`) | said from today: "in 3 days", "2 days ago" |
| A number whose name says its unit (`_minutes`, `_days`, `sq_ft`, `mileage`) | the figure with its unit |
| A 0/1 integer named like a yes-or-no (`is_`, `has_`, `_able`) | Yes or No |
| Text named `email`, `phone` or `url` | a link |
| A CHECK vocabulary of plain words | each word with a tone by what it says: `paid` good, `failed` bad, `on_hold` warn, `in_progress` info |
| A status a machine moves | tones by where each state stands: final states neutral, the last forward state good |
| A person's name in a people table (`customer`, `employee`, `mechanic`) | an initials disc, their email under it |
| A rollup or computed figure made of money | money |
| A record page that names no `layout` | the one its sections make: a gallery first a showcase, a timeline ending the main column a conversation, the record's long text with its facts alone an article, else the record's own |

Captions drop `_id`, `_at` and `_on`. A state's own stamp (`ready_at`) is written when the record enters that state. A form's vocabulary field starts at the schema's `DEFAULT`.

## When to use it, and when not

Use it as it comes: an App that declares less reads more clearly. Write a rule only where yours differs, such as a vocabulary word that means something else here, or a figure that is a count and not money.

## Options

Whatever the App writes wins, one part at a time:

- **The figure.** A declared `format`, `unit` or `bar` replaces the inferred one.
- **Tones.** A declared `tone` or `colors` replaces the inferred tones.
- **Words.** Declared `values` replace the inferred words.
- **The person's disc.** A declared avatar or mark replaces it.
- **Nothing at all.** An empty rule, `display: { price: {} }`, draws the column as stored.

## Common mistakes

- Writing out what the platform already does. `check` warns `restated`, and `mistri check --design --fix` deletes exactly those rules.
- Naming a count like money (`value`, `total`) and wondering why it wears a currency. Declare `format: 'number'` for it.

## Related

- [Display rules](/docs/vocabularies/): the rules you write when yours differ.
- [Design checks](/docs/design-lint/): `restated` and the other design warnings.
- [Dates and types](/docs/dates-and-types/): what a column's declared type lets it do.
