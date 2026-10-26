/**
 * The DSL tour reads a real sample, Loaner Desk, rather than a copy of one.
 * Each fence titled with a sample path is cut from that file: its lines are
 * there, in order (a `// …` line stands for lines left out), and the "See it
 * in the sample" link after it lands on its first line. A sample edit that
 * changes or moves a quoted line fails here, so the tour cannot drift. The
 * sample itself is typechecked, checked and executed by test/loaner-desk.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tour = readFileSync(resolve('site/src/content/docs/docs/dsl-tour.md'), 'utf8');
const fences = [
  ...tour.matchAll(/^```ts title="(examples\/apps\/[^"]+)"\n([\s\S]*?)^```\n\nSee it in the sample \(`(examples\/apps\/[^`:]+):(\d+)`\)/gm),
].map(([, title, body, linked, line]) => ({ title, lines: body.replace(/\n$/, '').split('\n'), linked, line: Number(line) }));

test('every titled fence in the tour is linked to its sample line', () => {
  const titled = [...tour.matchAll(/^```ts title="examples\//gm)].length;
  assert.ok(titled >= 6, `found ${titled} sample fences; the tour or this extraction changed`);
  assert.equal(fences.length, titled, 'a titled fence is not followed by its "See it in the sample" link');
});

test('every titled fence is cut from its sample, in order, at the linked line', () => {
  for (const { title, lines, linked, line } of fences) {
    assert.equal(linked, title, `the link after a ${title} fence names ${linked}`);
    const file = readFileSync(resolve(title), 'utf8').split('\n');
    assert.equal(file[line - 1], lines[0], `${title}#L${line} is not the fence's first line:\n  ${lines[0]}`);
    let at = line - 1;
    let skipping = false;
    for (const quoted of lines) {
      if (quoted.trim() === '// …') {
        skipping = true;
        continue;
      }
      /* Without an elision the next quoted line is the next line of the file. */
      const found = skipping ? file.indexOf(quoted, at) : file[at] === quoted ? at : -1;
      assert.ok(found >= 0, `${title} no longer has, at or after line ${at + 1}:\n  ${quoted}`);
      at = found + 1;
      skipping = false;
    }
  }
});
