import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test("every dashboard section's title takes a message of the App's catalogs, as the types say; the loader says it before any parser reads it", () => {
  const schema = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  const kinds = schema.$defs.dashSection.oneOf as Array<{
    properties: { kind: { const: string }; title: { oneOf?: Array<{ $ref?: string; type?: string }> } };
  }>;
  assert.ok(kinds.length > 10);
  for (const kind of kinds) {
    const title = kind.properties.title.oneOf ?? [];
    assert.deepEqual(
      title.map((option) => option.type ?? option.$ref),
      ['string', 'page.schema.json#/$defs/messageRef'],
      kind.properties.kind.const,
    );
  }
});
