/**
 * The capability matrix in tenant-apps.md ("What a tenant keeps") quotes the refusals and names the source file that
 * decides each row (F20). Prose that says "refused" for a thing the code serves misleads an author for a release, so
 * each quoted refusal must still be in the file the row names, and a served row's file must still exist.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const doc = readFileSync('site/src/content/docs/docs/tenant-apps.md', 'utf8');
const section = doc.slice(doc.indexOf('### What a tenant keeps'), doc.indexOf('### Sandboxes'));
const source = (file: string) => `packages/mistri/src/server/${file}`;

test('every file the matrix names exists', () => {
  const files = [...section.matchAll(/\| `((?:tenant|api)\/[A-Za-z]*\.?[A-Za-z]*(?:\.ts)?)` \|/g)].map((each) => each[1]);
  assert.ok(files.length >= 8, 'the matrix names its files');
  for (const file of files) assert.ok(existsSync(source(file)) || existsSync(source(file.replace(/\/$/, ''))), file);
});

test('the refusals the matrix quotes are the ones the code gives', () => {
  const inbound = 'inbound endpoints are not served on a tenant App: a delivery has no tenant to act for.';
  assert.ok(section.includes(inbound));
  assert.ok(readFileSync(source('tenant/tenantJobs.ts'), 'utf8').includes(inbound));
  const feed = 'A tenant App delivers its events through webhooks.';
  assert.ok(section.includes(feed));
  assert.ok(readFileSync(source('api/apiEventFeed.ts'), 'utf8').includes(feed));
});

test('webhook effects and integration webhooks are served, as the code says, and no page calls them refused', () => {
  assert.doesNotMatch(section, /Refused in a tenant App/);
  assert.match(readFileSync(source('tenant/tenantIntegrations.ts'), 'utf8'), /\/api\/inbound\/<name>\/<tenant>/);
  for (const page of ['events-and-jobs', 'integrations']) {
    const text = readFileSync(`site/src/content/docs/docs/${page}.md`, 'utf8');
    assert.match(text, /tenant-apps\/#what-a-tenant-keeps/, `${page} links to the matrix`);
    assert.doesNotMatch(text, /Not in\s+tenant Apps/);
  }
});
