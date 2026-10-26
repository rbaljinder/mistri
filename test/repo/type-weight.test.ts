/*
 * A weight past 700 is refused in every stylesheet the client ships: it
 * resolved Iowan Old Style to its Black cut (docs/design.md, Type).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inPackages } from '../support/packages.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const uncommented = (file: string) =>
  readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));

test('no stylesheet sets type heavier than 700', () => {
  const files = inPackages('src/client')
    .flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).map((file) => join(dir, file).split('\\').join('/')),
    )
    .filter((file) => file.endsWith('.css'));
  const problems = files.flatMap((file) =>
    uncommented(file)
      .split('\n')
      .flatMap((text, index) => {
        const weights = [...text.matchAll(/font(?:-weight)?\s*:\s*(\d{3})\b/g)].map((match) => Number(match[1]));
        return weights.filter((weight) => weight > 700).map((weight) => `${file}:${index + 1} sets weight ${weight}`);
      }),
  );
  assert.deepEqual(problems, []);
});
