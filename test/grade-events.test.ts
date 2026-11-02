/**
 * What grade hears from a page it measures: its uncaught errors, and what the platform says in the console of the
 * App's own mistake while it is written (an icon name that names none, appChrome.js): an error either way.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { watchEvents } from '../packages/mistri/src/server/build/gradeProbe.js';

test("the platform's console errors count as the page's, and the page's own console does not", () => {
  const heard = new Map<string, (value: unknown) => void>();
  const page = { on: (event: string, fn: (value: unknown) => void) => heard.set(event, fn) } as unknown as Page;
  const events = { errors: [] as string[], failed: [] as string[] };
  watchEvents(page, events);
  const say = (type: string, text: string) => heard.get('console')!({ type: () => type, text: () => text });
  say('error', 'mistri: no icon is called "hosue"; the nearest is "house".');
  say('error', 'a component of the App logged this');
  say('warning', 'mistri: a warning is not an error');
  heard.get('pageerror')!(new Error('boom\nat somewhere'));
  assert.deepEqual(events.errors, ['the page said: mistri: no icon is called "hosue"; the nearest is "house".', 'the page threw: boom']);
});
