# Chair

The suite's own App for who may read what on one page: a dental chair's schedule, opened by the dentist and by the
front desk, whose role reads visits and no note. Not a sample; `test/chair-fixture.test.ts` loads and serves it.

- `pages/schedule.page.tsx` names `note` in `optionalReads`: the desk is offered the page, and its read of the notes
  is refused before anything is read.
- `commands.ts` exports the `followUps` loader, which elevates its read of `note` and returns the follow-up asks
  alone.

- `bookVisit` is the desk's one command, so the App has a registry to type its pages against.

`node --import tsx test/fixtures/apps/chair/seed.mjs <new-file.db>` writes its database and a connection file beside it.
