/**
 * What a reader hears when the server does not answer, or answers with something that is not JSON. An App's reader
 * was told "tablewalk is not answering", the database browser's name, which meant nothing in Compass: no sentence
 * an App's reader can hear names tablewalk. The Workbench keeps its wording.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { unansweredSentence, uninterpretableSentence } from './core.js';
import { installShell, resetShell } from './shellMode.js';

afterEach(() => {
  resetShell();
  vi.unstubAllGlobals();
});

const inApp = () => installShell({ inApp: () => true, app: () => ({ name: 'Compass' }) as never });

test('an App on this machine is named, and no sentence its reader hears says tablewalk', () => {
  inApp();
  expect(location.hostname).toBe('localhost');
  const said = [unansweredSentence(), uninterpretableSentence(502)];
  expect(said[0]).toBe('Compass is not answering. The server it was started with may have stopped — restart it and reload this page.');
  expect(said[1]).toContain('Something between this page and Compass may be intercepting the request.');
  for (const sentence of said) expect(sentence).not.toMatch(/tablewalk/i);
});

test('the Workbench keeps its own words', () => {
  expect(unansweredSentence()).toMatch(/^tablewalk is not answering\./);
  expect(uninterpretableSentence(502)).toMatch(/between this page and tablewalk/);
});

test('offline comes first, for an App as for the Workbench', () => {
  inApp();
  vi.stubGlobal('navigator', { ...navigator, onLine: false });
  expect(unansweredSentence()).not.toMatch(/Compass|tablewalk/);
});
