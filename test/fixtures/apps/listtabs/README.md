# Listtabs · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/page-layers.spec.ts`](../../../../e2e/page-layers.spec.ts) can measure a
record page whose related lists are a strip of tabs (`listTabs: true`), writable, where a
tab holds an empty list. Anvil has parts and a note; Bellows has neither.

The names are invented. Sized to its spec: do not grow it to demonstrate a feature.
