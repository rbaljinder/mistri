/**
 * Writes the store-layout fixtures (scripts/store-layouts.mjs). `--write`
 * provisions every store fresh, on a database of its own, and keeps the SQL
 * of the version this build expects. A fixture that exists, of any version,
 * is never rewritten: it is the record, and a changed layout is a new version
 * with a step and a new file.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { STORES } from '../../packages/mistri/src/server/storeLayouts.js';
import { ENGINES, LIVE, PROVISION, dumpFixture, fixturePath, headerOf, scratch } from './storeLayouts.js';

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

export async function writeFixtures(): Promise<string[]> {
  const written: string[] = [];
  for (const layout of STORES)
    for (const engine of ENGINES) {
      const provision = PROVISION[layout.id]?.[engine],
        current = layout.current[engine];
      if (!provision || current === undefined || (engine === 'postgres' && !LIVE)) continue;
      const path = fixturePath(layout.id, engine, current);
      if (existsSync(path)) continue;
      const where = await scratch(engine, `fx_${layout.id}`);
      try {
        await provision(where.url);
        write(path, await dumpFixture(engine, where.url, headerOf(layout.id, engine, current)));
        written.push(path);
      } finally {
        await where.drop();
      }
    }
  return written;
}
