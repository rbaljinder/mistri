# AI proposals (test fixture)

The browser gate's own App for AI proposals (`e2e/ai-proposals.spec.ts`): the
assistant, driven by the scripted model in `assistant.json`, keeps two commands
for review; a signed-in clerk approves one from For review (`/review`) and
dismisses the other. The run is the clerk's, and its receipt names the proposal
the assistant made.

- `app.ts`: one resource, `claim`, with two command actions and a panel assistant.
- `commands.ts`: `sendAppeal` (declared `approval: 'ai'`) and `closeClaim`.
- `seed.mjs`: two open claims, the command journal and the assistant store.

Owned by the test suite; not a sample App.
