/**
 * A test's App with catalogs, held as loading one from its directory holds them (apps.ts loadApp): each
 * messages/<locale>.mjs written and read, the definition said in its source language, and its localizer held, so a
 * reader's locale says it in theirs (`localizedApp`) and its components are handed the words (`componentMessages`).
 * The localizer is the App id's latest too, as a load's is: one App id per file holds catalogs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  catalogFiles,
  holdLocalizer,
  localizeDefinition,
  MessageSayer,
  readCatalogs,
} from '../../packages/mistri/src/server/app/appMessages.js';
import type { AppDef } from '../../packages/mistri/src/shared/app.js';
import { catalogOf, namedCommands, parseTestApp } from './commandCatalog.js';

type Raw = Record<string, unknown>;

export async function parseWordedApp(
  raw: Raw,
  where: string,
  dir: string,
  /** Each locale's entries; the App's source language is `ui.locale`, else `en`. */
  words: Record<string, Record<string, string>>,
  contracts: Record<string, Raw> = {},
): Promise<AppDef> {
  mkdirSync(join(dir, 'messages'), { recursive: true });
  for (const [locale, entries] of Object.entries(words))
    writeFileSync(join(dir, 'messages', `${locale}.mjs`), `export default ${JSON.stringify({ kind: 'messages', locale, entries })};\n`);
  const source = typeof (raw.ui as { locale?: unknown } | undefined)?.locale === 'string' ? String((raw.ui as Raw).locale) : 'en';
  const catalogs = await readCatalogs(dir, await catalogFiles(dir), source, async (href) => (await import(href)).default);
  if (!catalogs) throw new Error(`${where}: no catalogs were read.`);
  const path = join(dir, 'app.ts');
  const app = parseTestApp(localizeDefinition(raw, new MessageSayer(catalogs, catalogs.source), path), where, contracts);
  const { app: lifted, commands } = namedCommands(raw);
  for (const [id, entry] of catalogOf(contracts)) commands.set(id, entry);
  holdLocalizer(app, { definition: { raw: lifted, path, catalog: commands, filePages: [] }, catalogs });
  return app;
}
