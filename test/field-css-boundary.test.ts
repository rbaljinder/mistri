import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inPackages } from './support/packages.js';

/**
 * A field report from the user's own App: the platform's field styles were written `.page-field dd`, which also
 * matches a `dd` inside the value (a custom component's own list, the JSON viewer's), restyling it at the field
 * value's weight and size. A field's caption and value are its direct children, so the selectors say so and stop
 * at the component boundary.
 */
function sheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sheets(join(dir, entry.name)) : entry.name.endsWith('.css') ? [join(dir, entry.name)] : [],
  );
}

test('no stylesheet reaches a field value by a descendant dt or dd', () => {
  const found: string[] = [];
  for (const file of inPackages('src/client').flatMap(sheets))
    for (const [number, line] of readFileSync(file, 'utf8').split('\n').entries())
      if (/\.(?:page-field|page-sheet-row|page-card-fact|cards-fact)\s+(?:dt|dd)\b/.test(line))
        found.push(`${file}:${number + 1} ${line.trim()}`);
  assert.deepEqual(found, []);
});
