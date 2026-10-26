# Internal App Regression Fixtures

These are frozen feature-regression fixtures, not public starter applications.
They retain existing theme, layout, relational-action and Service Desk coverage.
The public examples are Tick and Lintel, and only those two ship in the npm
package.

For user or LLM authoring, start at [the public catalog](../../../examples/apps/README.md).
Tests create disposable databases; do not use or reseed running preview data.
Old fixture READMEs describe their historical scenarios, not the supported sample
catalog. Keep new product examples out of this directory.

## Examples until 0.9.2

Nine of these were public examples until 0.9.2 and were moved here, not
deleted, because each still holds the only browser or end-to-end coverage of
some feature, and specs, bundle budgets and visual baselines run on them:

| Fixture | Was | Seed |
| --- | --- | --- |
| `crm` | Compass, the CRM | [`databases/crm`](../databases/crm) |
| `thread` | Thread, the issue tracker | [`databases/thread`](../databases/thread) |
| `keystone` | Keystone, six mounted Apps over PostgreSQL | [`databases/keystone`](../databases/keystone) |
| `forecourt-market` | Forecourt, the used-car marketplace | [`databases/forecourt`](../databases/forecourt) |
| `payday` | Payday, people and payroll | [`databases/payday`](../databases/payday) |
| `depot` | Depot, the warehouse | [`databases/depot`](../databases/depot) |
| `commons` | Commons, the forum | [`databases/commons`](../databases/commons) |
| `atelier` | Atelier, a fashion shop's back office | [`databases/atelier`](../databases/atelier) |
| `loaner-desk` | Loaner Desk, guarded checkout | [`databases/loaner-desk`](../databases/loaner-desk) |

Their seeds live in [`test/fixtures/databases/`](../databases/), so nothing
under `examples/databases/` but Tick, Lintel and Ignition's seed remains. They
are frozen: change one only to keep its suites meaningful, never to promote it.
Where Lintel shows the same capability, a doc or an agent should point at
Lintel; these remain for the specs that need their particular shape.

Not every fixture here is frozen. [`command-desk`](command-desk/README.md) is
the browser gate's own App: three specs that check framework behaviour used to
borrow a public sample's seed, and lost the whole gate when that sample was
reshaped. A gate's fixtures belong to the gate.
