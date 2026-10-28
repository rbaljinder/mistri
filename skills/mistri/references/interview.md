# Step 0: the brief

Build nothing until the person has approved a brief. A brief is one page, [BRIEF.md](brief-template.md): what they said, what
you derived from it, and a machine block `mistri new --brief` can scaffold from. The cost of a wrong guess grows with
every file written; a question costs one line.

## Rules of the interview

- **Rounds of at most four questions.** Ask a round, wait, fold the answers in, then decide whether another is needed.
  Most Apps need two or three rounds; a clear request needs one.
- **Every question has a default**, said with it: "Roles: front desk and manager (default), or just one?" The person may
  answer "defaults", and then the defaults are the answer.
- **Skip what is known.** Read the request first, and if a database exists, `npx @mistriwork/mistri schema --brief`: tables, keys and
  status columns answer most of "domain things" and "data". Never ask what the schema or the request already says; say
  what you inferred and ask only to confirm.
- **Say what each answer decides** when it is not obvious ("tenancy: one company, or many companies each seeing only
  their own rows? It cannot be changed cheaply later").
- Ask in the person's words, not the DSL's. "Who may change a booking after it is confirmed?" not "write grants".

## The rounds, in order

Take a topic only when something in it is still open. Each bullet is one question; a round takes up to four.

**1. Purpose, people, roles, tenancy**
- What is the App for, in one sentence, and what is the first thing a person does in it? (default: the request's own words)
- Who uses it, and do they differ in what they may see or change? (default: staff, plus an admin who changes everything)
- One organization, or several that must never see each other's rows? (default: one; many is a tenant App,
  [choices.md](choices.md))
- Do people sign in by email? (default: yes, staff only; no sign-in only for a throwaway)

**2. Domain: things, relations, life cycles**
- What are the things it keeps, and which belongs to which? (default: infer from the request, list them back)
- Which things move through states (requested, confirmed, done), and who moves them? (default: one status column per
  such thing, the states in the order said)
- What does a person never need to see? (default: nothing hidden; secrets are [security.md](security.md)'s)

**3. Rules and journeys**
- What must the App refuse? ("A booking needs a walker before it is confirmed.") (default: only what the schema enforces)
- What are the two or three journeys that must work end to end? (default: create, work a record to its final state,
  find it again)
- Does anything need an approval, a reason, or an audit trail? (default: no)

**4. Data**
- A new database or one that exists? If it exists, may the App write to it? (default: new; ask before touching existing data)
- PostgreSQL or SQLite? (default: SQLite to start, PostgreSQL to ship)
- Rows to import, from what? (default: none)
- How real should the sample data look? (default: believable names, dates and amounts from `mistri seed`)

**5. The outside world**
- Does anyone without an account need a page or a form (a booking form, a status page)? (default: no)
- Email, SMS, payments or another system? (default: none; each is a seam to settle later, not a build step now)
- A reader of the data outside the App (API, reports, exports)? (default: CSV export only)

**6. Look and feel**
- A built-in look: Workshop (default, paper and ink, condensed capitals), Lumen (soft and modern), Mono (black and white, dense) or Sage (warm, soft cards)? And one of the twelve palettes?
- A product or screenshot to echo? (default: none; a screenshot beats adjectives)
- Density, brand color, logo? (default: comfortable, the look's own color, an icon from the App icons)
- Dark mode, and phone use? (default: both work; say so only if phone is the main device)

**7. Locale**
- Language, currency and date style? (default: English, the person's currency, their date order)

## After the answers

1. Fill [BRIEF.md](brief-template.md): the answers, then what you derived. The derived part is where mistakes hide, so write
   it as the person will read it: the schema as a short list of things and their fields, the screen list, each
   command with what it refuses, who may do what, the look in a sentence.
2. Show it and ask for approval, or for corrections. **No scaffold, seed, migration or file in the App's folder before
   the person says it is right.**
3. On approval: `npx @mistriwork/mistri new --brief BRIEF.md ./my-app` for a new database, or, over a database that exists,
   `npx @mistriwork/mistri --config mistri.json --scaffold-app ./my-app` and carry the brief's roles, commands and look into
   `app.ts` by hand. Then the loop continues at step 1 of [SKILL.md](../SKILL.md).

## When no one is there to answer

A full brief can arrive in one message, or the session is not interactive. Then do not interview:

1. Fill BRIEF.md from what was given, marking each field you had to assume with `(assumed)`.
2. Ask only the gaps that change a hard-to-undo choice: tenancy, whether existing data may be written, roles and what
   must be refused. Everything else takes its default and says so in the brief.
3. If you cannot ask at all, proceed on defaults for a disposable copy only, put the assumption list first in your
   hand-back, and do not touch an existing database.

## The machine block

`mistri new --brief` reads one fenced block, `json mistri-brief`; the rest of BRIEF.md is for people. A field is one
string, `"<type> [<argument>] [!] [unique] [=<default>]"`:

| Type | Makes | Example |
| --- | --- | --- |
| `text`, `longtext`, `email`, `phone` | a text column | `"email": "email! unique"` |
| `int`, `number`, `money` | a number | `"minutes": "int! =30"`, `"price": "money"` |
| `bool` | a yes/no (default `=true` or no) | `"active": "bool =true"` |
| `date`, `datetime` | a day, a moment | `"scheduled_at": "datetime!"` |
| `ref <entity>` | a reference; the column is `<name>_id` | `"dog": "ref dog!"` |
| `choice a\|b\|c` | one of these, in life-cycle order | `"status": "choice requested\|confirmed\|done =requested"` |

`!` is required. Entities are lowercase singular names; `id` is added. A `choice` named `status` becomes the entity's
machine, its states in the order given. `roles` grant `read` and `write` (`true` or a list of entities) and the
`commands` a role may run. A command names the entity it acts on, a `when` condition for where its button shows, the
columns it `set`s, and the `refuse` rules in the reader's words: the stub lists each as a TODO, because a rule is code
only the person's data can settle. `app.theme` is `workshop`, `lumen`, `mono` or `sage`; `app.logo` an icon from the App icons.
