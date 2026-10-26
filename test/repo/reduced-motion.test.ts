/*
 * Motion doctrine 6 (docs/design.md): `prefers-reduced-motion: reduce`
 * silences all of it. An enter effect or a hover fade is declared inside a
 * `no-preference` block, so reduction is the default rather than a patch; the
 * few that predate that pattern name themselves again under `reduce`. Two
 * chevrons that turned and eleven fades had slipped out of both, and moved
 * for a reader who asked for stillness. This scan keeps every stylesheet the
 * client ships to one of the two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inPackages } from '../support/packages.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const CLIENT = 'src/client';

interface Motion {
  file: string;
  line: number;
  selector: string;
  guarded: boolean;
  reduce: boolean;
  still: boolean;
}

/** Every animation or transition declaration, with the blocks it sits in. */
function motions(file: string): Motion[] {
  const css = readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  const found: Motion[] = [];
  const stack: string[] = [];
  let buffer = '';
  let line = 1;
  const flush = () => {
    const match = /^(animation|transition)(-name|-duration)?\s*:\s*([\s\S]+)$/.exec(buffer.trim());
    if (match) {
      const value = match[3]!.trim();
      found.push({
        file,
        line,
        selector: (stack.at(-1) ?? '').replace(/\s+/g, ' ').trim(),
        guarded: stack.some((block) => /prefers-reduced-motion:\s*no-preference/.test(block)),
        reduce: stack.some((block) => /prefers-reduced-motion:\s*reduce/.test(block)),
        still: /^(none|0m?s)$/.test(value),
      });
    }
    buffer = '';
  };
  for (const ch of css) {
    if (ch === '\n') line++;
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (ch === '}') {
      flush();
      stack.pop();
    } else if (ch === ';') flush();
    else buffer += ch;
  }
  return found;
}

test('every animation and transition is silenced by prefers-reduced-motion: reduce', () => {
  const files = inPackages(CLIENT).flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .map((file) => join(dir, file).split('\\').join('/'))
      .filter((file) => file.endsWith('.css')),
  );
  const all = files.flatMap(motions);
  const stilled = new Set(all.filter((m) => m.reduce && m.still).map((m) => m.selector));
  const problems = all
    .filter((m) => !m.guarded && !m.reduce && !m.still && !stilled.has(m.selector))
    .map(
      (m) => `${m.file}:${m.line} moves "${m.selector}" for every reader; declare it under @media (prefers-reduced-motion: no-preference).`,
    );
  assert.deepEqual(problems, []);
});
