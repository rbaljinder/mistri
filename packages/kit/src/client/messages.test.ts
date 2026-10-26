import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  defineMessages,
  message,
  messageLanguage,
  offeredLanguages,
  onLanguagePicked,
  setMessageLanguage,
  setMessageScope,
  subscribeMessages,
} from './messages.js';

beforeEach(async () => {
  localStorage.clear();
  await setMessageScope();
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
});

afterEach(() => vi.restoreAllMocks());

test('keeps language choices isolated and restores each app choice', async () => {
  await setMessageScope('compass');
  await setMessageLanguage('es');
  expect(localStorage.getItem('mistri.messages.language.app.compass')).toBe('es');
  expect(message('navigation.menu')).toBe('Menú');

  await setMessageScope('ignition');
  expect(messageLanguage()).toBe('en');
  await setMessageLanguage('es');
  await setMessageScope('compass');
  expect(messageLanguage()).toBe('es');
  await setMessageScope('ignition');
  expect(messageLanguage()).toBe('es');
});

test('falls back to English for missing and invalid saved languages, while accepting Spanish regional storage', async () => {
  localStorage.setItem('mistri.messages.language.app.compass', 'fr');
  await setMessageScope('compass');
  expect(messageLanguage()).toBe('en');

  localStorage.setItem('mistri.messages.language.app.compass', 'es-MX');
  await setMessageScope('other');
  await setMessageScope('compass');
  expect(messageLanguage()).toBe('es');
});

test('uses language plural rules and preserves zero and braces in interpolation values', async () => {
  await setMessageScope('compass');
  expect(message('list.rows', { count: 0 })).toBe('0 rows');
  expect(message('list.rows', { count: 1 })).toBe('1 row');
  expect(message('list.rows', { count: 2 })).toBe('2 rows');
  expect(message('list.rows', { count: '{zero}' })).toBe('{zero} rows');

  await setMessageLanguage('es');
  expect(message('list.rows', { count: 0 })).toBe('0 filas');
  expect(message('list.rows', { count: 1 })).toBe('1 fila');
  expect(message('list.rows', { count: 2 })).toBe('2 filas');
});

test('tolerates unavailable storage and only notifies for actual scope or language changes', async () => {
  const changed = vi.fn();
  const stop = subscribeMessages(changed);
  const get = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  await setMessageScope('compass');
  expect(messageLanguage()).toBe('en');
  await setMessageScope('compass');
  expect(changed).toHaveBeenCalledTimes(1);
  get.mockRestore();

  const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  await setMessageLanguage('es');
  expect(messageLanguage()).toBe('es');
  expect(document.documentElement.lang).toBe('es');
  expect(document.documentElement.dir).toBe('ltr');
  await setMessageLanguage('es');
  expect(changed).toHaveBeenCalledTimes(2);
  await setMessageScope('another-app');
  await setMessageScope('compass');
  expect(messageLanguage()).toBe('es');
  write.mockRestore();
  stop();
});

test('an app named workbench does not share the database browser preference', async () => {
  await setMessageScope('workbench');
  await setMessageLanguage('es');
  await setMessageScope();
  expect(messageLanguage()).toBe('en');
  await setMessageScope('workbench');
  expect(messageLanguage()).toBe('es');
});

test("a module's table says its own keys and the shared ones, in English where it has no translation", async () => {
  const say = defineMessages(
    {
      saved: 'Saved “{name}” for {table}.',
      rows: { one: '{count} row shown', other: '{count} rows shown' },
      empty: 'Nothing here yet.',
    },
    { es: { empty: 'Nada todavía.' } },
  );
  await setMessageScope('depot');
  expect(say('saved', { name: 'Open leads', table: 'lead' })).toBe('Saved “Open leads” for lead.');
  expect(say('rows', { count: 1 })).toBe('1 row shown');
  // A count is written as locale.ts's plural wrote it, grouped for the reader.
  expect(say('rows', { count: 1234 })).toBe('1,234 rows shown');
  expect(say('common.close')).toBe('Close');
  // The key's text types its holes: one left out, one it has not, or a key it does not know is a compile error.
  // @ts-expect-error `table` is missing
  expect(say('saved', { name: 'Open leads' })).toBe('Saved “Open leads” for {table}.');
  // @ts-expect-error `empty` has no holes
  say('empty', { name: 'x' });
  // @ts-expect-error no such key
  expect(say('nowhere')).toBe('nowhere');

  await setMessageLanguage('es');
  expect(say('empty')).toBe('Nada todavía.');
  expect(say('saved', { name: 'Abiertos', table: 'lead' })).toBe('Saved “Abiertos” for lead.');
  expect(say('common.close')).toBe('Cerrar');
  // A shared word the Spanish does not have yet is said in English.
  expect(say('common.untitled')).toBe('Untitled');
  expect(message('common.untitled')).toBe('Untitled');
});

test('the Spanish words are a chunk of their own, fetched when asked for and said once here', async () => {
  const words = await import('./copy/es.js');
  expect(words.default['navigation.menu']).toBe('Menú');
  await setMessageScope('ledger', { locale: 'es-AR' });
  // No choice in this browser: the nearest to the tag the server said.
  expect(messageLanguage()).toBe('es');
  expect(message('navigation.menu')).toBe('Menú');
});

test("an App with words in several languages follows the server; a pick is the App's cookie, and the App is asked again", async () => {
  const told = vi.fn();
  const stop = onLanguagePicked(told);
  localStorage.setItem('mistri.messages.language.app.payday', 'en');
  await setMessageScope('payday', { locale: 'es-MX', offered: ['en', 'es'] });
  // The server's answer is the language, over this browser's old choice.
  expect(messageLanguage()).toBe('es');
  expect(offeredLanguages()).toEqual(['en', 'es']);
  await setMessageLanguage('en');
  expect(messageLanguage()).toBe('en');
  expect(document.cookie).toContain('mistri-locale-payday=en');
  expect(told).toHaveBeenCalledWith('en');
  stop();
  await setMessageScope('ledger');
  expect(offeredLanguages()).toEqual([]);
});
