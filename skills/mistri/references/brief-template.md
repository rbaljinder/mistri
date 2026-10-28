# Brief: <App name>

Status: draft | approved by <name> on <date>

## What I heard

- **Purpose:** <one sentence>
- **People and roles:** <who, and what each may do>
- **Tenancy:** one organization | many, each seeing only their own rows
- **Domain:** <the things, their relations and life cycles, in the person's words>
- **Rules and journeys:** <what is refused; the two or three journeys that must work>
- **Data:** new | existing (<where>), SQLite | PostgreSQL, imports <none | what>, sample data <believable | none>
- **Outside world:** <public pages or forms, email, integrations, API, reports; or none>
- **Look and feel:** <built-in look, reference, density, brand color, logo, dark mode, phone>
- **Locale:** <language, currency, dates>

Assumed, not asked (strike what is wrong): <list, or none>

## What I will build

**Schema** (one line per thing: fields, references, states)

- <thing>: <fields>; belongs to <thing>; states <a → b → c>

**Screens** (the nav, in order, and what each shows)

1. <Overview: the figures and the newest rows>
2. <List: columns, tabs, search>
3. <Record page: what is on it, what it links to>

**Commands** (each with what it refuses)

- <Name> on <thing>, where <condition>: <what it changes>. Refuses: <rule in the reader's words>.

**Roles and access**

| Role | Reads | Writes | Runs |
| --- | --- | --- | --- |
| <role> | <things or all> | <things or none> | <commands> |

**Theme direction:** <look, color, density, and the one thing the App should feel like>

**Not in this build:** <what the person asked about that waits, and why>

## Machine block

`npx @mistriwork/mistri new --brief BRIEF.md ./app` reads this block and nothing else of the document.

```json mistri-brief
{
  "app": { "name": "<App name>", "theme": "workshop", "logo": "calendar" },
  "entities": {
    "client": { "name": "text!", "email": "email unique", "phone": "phone" },
    "booking": {
      "client": "ref client!",
      "scheduled_at": "datetime!",
      "status": "choice requested|confirmed|done =requested"
    }
  },
  "roles": {
    "staff": { "label": "Staff", "read": true, "write": ["booking"], "commands": [] },
    "admin": { "label": "Admin", "read": true, "write": true, "commands": ["confirmBooking"] }
  },
  "commands": [
    {
      "id": "confirmBooking",
      "on": "booking",
      "label": "Confirm",
      "when": "status = requested",
      "set": { "status": "confirmed" },
      "refuse": ["<a rule, in the reader's words>"]
    }
  ]
}
```
