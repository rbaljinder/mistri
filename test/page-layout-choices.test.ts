/**
 * The layout every sample and fixture App's record pages are drawn in (shared/pageLayouts.ts, chooseLayout): the
 * ones their authors wrote, and the ones their sections make where they wrote none. A new chosen layout, or one
 * lost, shows up here as a line to read: where a choice is wrong, the rule is what changes, not the App.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { parseAppPages } from '../packages/mistri/src/shared/appPages.js';
import type { PageDef } from '../packages/engine/src/shared/page.js';

const examples = resolve('examples/apps');
const fixtures = resolve('test/fixtures/apps');
/* The Apps a host hands their commands (tenant-*, command-desk): their manifests' pages are read alone. */
const PAGES_ONLY = new Set([
  'command-desk',
  'tenant-ignition',
  'tenant-ignition/assignment',
  'tenant-ignition/inventory',
  'tenant-thread',
  'tenant-thread/notes',
]);

/** Each App directory under the two roots, a suite's (keystone) by each of its Apps. */
function apps(): Array<{ name: string; dir: string }> {
  const found: Array<{ name: string; dir: string }> = [];
  for (const root of [examples, fixtures]) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const hasManifest = (at: string) => ['app.ts', 'app.mjs', 'app.json'].some((file) => existsSync(join(at, file)));
      if (hasManifest(dir)) found.push({ name: entry.name, dir });
      for (const inner of readdirSync(dir, { withFileTypes: true })) {
        if (inner.isDirectory() && hasManifest(join(dir, inner.name)))
          found.push({ name: `${entry.name}/${inner.name}`, dir: join(dir, inner.name) });
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function pagesOf(name: string, dir: string): Promise<readonly PageDef[]> {
  if (!PAGES_ONLY.has(name)) return (await loadApp(dir, { lock: 'report' })).pages;
  const definition = (await import(pathToFileURL(join(dir, 'app.ts')).href)).default;
  return parseAppPages(definition, name);
}

/* Every page drawn in an archetype: `written` where its author said so, the reason where its sections chose it.
   Every other screen page in these Apps is the record's own. */
const DRAWN: Record<string, string> = {
  'lintel maintenance_request': 'conversation written',
  'lintel property': 'showcase written',
  'lintel resident_request': 'conversation written',
  'lintel unit': 'showcase written',
  'tick task': 'article written',
  'commons report': `article: it is the record's words, "details", with 9 facts and nothing else`,
  'desk-blocks ticket': 'conversation: its main column ends with the timeline "Conversation", and no list stands in it',
  'forecourt inquiry': 'conversation: its main column ends with the timeline "Follow-up history", and no list stands in it',
  'forecourt vehicle': 'showcase: it opens with the gallery "Photos", with a panel beside it',
  'forecourt-market inquiry': 'conversation: its main column ends with the timeline "Conversation", and no list stands in it',
  'forecourt-market vehicle': 'showcase: it opens with the gallery "Photos", with a panel beside it',
  'ignition decision': `article: it is the record's words, "record_note", with 4 facts and nothing else`,
  'ignition review': `article: it is the record's words, "summary", with 6 facts and nothing else`,
  'keystone/dealer vehicle': 'showcase: it opens with the gallery "Photos", with a panel beside it',
  'keystone/marketplace vehicle': 'showcase: it opens with the gallery "Photos", with a panel beside it',
  'keystone/site vehicle': 'showcase: it opens with the gallery "Photos", with a panel beside it',
  'service-desk knowledge': `article: it is the record's words, "summary" and "body", with 5 facts and nothing else`,
  'tenant-ignition activity': `article: it is the record's words, "body", with 3 facts and nothing else`,
  'tenant-ignition/assignment activity': `article: it is the record's words, "body", with 3 facts and nothing else`,
  'tenant-ignition/inventory activity': `article: it is the record's words, "body", with 3 facts and nothing else`,
  'tenant-thread comment': `article: it is the record's words, "body", with 3 facts and nothing else`,
  'tenant-thread/notes comment': `article: it is the record's words, "body", with 3 facts and nothing else`,
  'tenant-thread/notes discussion': 'conversation: its main column ends with the timeline "Notes", and no list stands in it',
};

test('every sample and fixture record page is drawn in the layout its author wrote or its sections make', async () => {
  const drawn: Record<string, string> = {};
  let record = 0;
  for (const { name, dir } of apps()) {
    for (const page of await pagesOf(name, dir)) {
      if (page.document) {
        assert.equal(page.layout, undefined, `${name} ${page.id}: a document has paper's layout`);
        continue;
      }
      if (page.layout === undefined || page.layout === 'record') record++;
      else drawn[`${name} ${page.id}`] = page.layoutWhy ? `${page.layout}: ${page.layoutWhy}` : `${page.layout} written`;
    }
  }
  assert.deepEqual(drawn, DRAWN);
  // The rest keep the record's skeleton: most record pages are records, lists beside a rail.
  assert.ok(record > 100, `${record} pages drawn as the record's own`);
});
