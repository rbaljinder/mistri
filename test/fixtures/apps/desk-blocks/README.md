# Desk blocks · browser gate fixture

An internal regression fixture, not a starter application (see [the public catalog](../../../../examples/apps/README.md)).
It gives `e2e/desk-conversation.spec.ts` an App of its own for the conversation timeline, the split that chooses its
rows and keys, and the header that names its verbs, and `e2e/preview-blocks.spec.ts` the caller's side of that
conversation, a change calendar over its freezes and holidays, and a dashboard with the desk's own component
(`widgets/`). `seed.mjs` is the schema; ticket 1 holds the conversation, and the changes fall in the seeding month.
