/**
 * The words a value component says its column's values as. A rule whose
 * `component` draws the word, with no `values`, left every plain-text
 * surface (a breakdown's keys, a chip, a select, the CSV) showing the stored
 * code. The component's module may export `label(value)`; it is called here,
 * once per value of the column's vocabulary, in a throwaway worker with no
 * environment and the same inert stand-ins a free-form page is read under
 * (appPages.ts), and the words it gave are served as the rule's `values`
 * (shared/appDisplayResolve.ts). It is never called per value at read time:
 * author code on the export path, once per row, is a cost and a trust surface
 * the vocabulary's few values do not need.
 *
 * The vocabulary is the catalog's, so this runs where an App meets its
 * schema (a request's source, `mistri check`), not at parse: what it
 * learns is kept on the definition (`AppDef.valueLabels`) and what it finds
 * wrong is kept beside it for `appProblems` and `appAdvisories`.
 */
import { Worker } from 'node:worker_threads';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from '../../shared/appModel.js';
import type { ComponentDecl } from '@mistriwork/engine/shared/appComponents.js';
import { astParser, dataUrl, withStandIns } from './appPages.js';
import { compilePageModule } from './appComponents.js';
import type { LoadedApp } from './apps.js';

/** The longest word a label may be: it is drawn in a legend, a chip and a select. */
const MAX_LABEL = 80;

/** What learning has found and done for one load, kept beside its `valueLabels`. */
interface Learned {
  problems: Set<string>;
  warnings: Set<string>;
  /** "resource.column\nvalue" pairs already asked, so a request after the first asks nothing. */
  asked: Set<string>;
  /** Whether each component's module exports `label`, by id. */
  exports: Map<string, boolean>;
}
const learned = new WeakMap<object, Learned>();

/** The holder a load keeps what it learns on: present when a display rule draws a value with a component. */
export function valueLabelHolder(app: AppDef): AppDef['valueLabels'] {
  const draws = Object.values(app.resources ?? {}).some((resource) =>
    Object.values(resource.display ?? {}).some((rule) => rule.component?.kind === 'value'),
  );
  return draws ? {} : undefined;
}

/** A column's vocabulary: what the catalog declares, a machine's states, and the values the rule itself names. */
function vocabularyOf(app: AppDef, schema: DatabaseSchema, resource: string, column: string): string[] {
  const table = tableNamed(schema, resource);
  const rule = app.resources?.[resource]?.display?.[column];
  const machine = app.resources?.[resource]?.machine;
  return [
    ...new Set([
      ...(table?.columns.find((candidate) => candidate.name === column)?.allowed ?? []),
      ...(machine && machine.column === column ? machine.states.map((state) => state.name) : []),
      ...Object.keys(rule?.values ?? {}),
      ...Object.keys(rule?.tone ?? {}).filter((key) => !/^[<>]=?\s|^\*$/.test(key)),
      ...Object.keys(rule?.icons ?? {}),
    ]),
  ];
}

interface Outcome {
  has: boolean;
  said: Array<{ value: string; word?: string; error?: string }>;
}

/** The module's `label`, called for each value in a worker with no environment. */
function evaluate(code: string, values: readonly string[]): Promise<Outcome> {
  return new Promise((resolveOutcome, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       import(workerData.href).then(
         (mod) => {
           if (typeof mod.label !== 'function') return parentPort.postMessage({ ok: true, has: false, said: [] });
           const said = workerData.values.map((value) => {
             try {
               const word = mod.label(value);
               if (word && typeof word.then === 'function') return { value, error: 'returned a Promise; label is synchronous' };
               return { value, word };
             } catch (err) {
               return { value, error: 'threw: ' + String((err && err.message) || err) };
             }
           });
           parentPort.postMessage({ ok: true, has: true, said });
         },
         (err) => parentPort.postMessage({ ok: false, message: String((err && err.message) || err) }),
       );`,
      { eval: true, workerData: { href: dataUrl(code), values }, env: {} },
    );
    const done = (fn: () => void) => {
      void worker.terminate();
      fn();
    };
    worker.once('message', (m: { ok: boolean; has?: boolean; said?: Outcome['said']; message?: string }) =>
      done(() => (m.ok ? resolveOutcome({ has: m.has!, said: m.said! }) : reject(new Error(m.message)))),
    );
    worker.once('error', (err) => done(() => reject(err)));
    const timer = setTimeout(() => done(() => reject(new Error('the value component did not finish loading within 10s'))), 10_000);
    timer.unref();
  });
}

/**
 * Learn the words of every value component on this catalog's vocabularies.
 * Safe to call on every request: a value is asked once. Nothing is learned
 * (and nothing said) for an App without a directory or without rolldown,
 * which cannot compile the module either.
 */
export async function learnValueLabels(loaded: LoadedApp, schema: DatabaseSchema): Promise<void> {
  const holder = loaded.app.valueLabels;
  if (!holder || !loaded.dir || loaded.build) return;
  let state = learned.get(holder);
  if (!state)
    learned.set(
      holder,
      (state = {
        problems: new Set(),
        warnings: new Set(),
        asked: new Set(),
        exports: new Map(),
      }),
    );
  const code = new Map<string, string | undefined>();
  const parse = await astParser().catch(() => undefined);
  if (!parse) return;
  for (const [resource, def] of Object.entries(loaded.app.resources ?? {})) {
    for (const [column, rule] of Object.entries(def.display ?? {})) {
      const decl: ComponentDecl | undefined = rule.component?.kind === 'value' ? rule.component : undefined;
      if (!decl || !tableNamed(schema, resource)) continue;
      const key = `${resource}.${column}`;
      const vocabulary = vocabularyOf(loaded.app, schema, resource, column);
      const fresh = vocabulary.filter((value) => !state.asked.has(`${key}\n${value}`));
      const knownExports = state.exports.get(decl.id);
      if (knownExports === false) continue;
      if (knownExports !== undefined && !fresh.length) continue;
      if (!code.has(decl.id)) {
        const compiled = await compilePageModule(loaded.dir, decl).catch(() => undefined);
        code.set(decl.id, compiled === undefined ? undefined : withStandIns(parse, compiled));
      }
      const source = code.get(decl.id);
      if (source === undefined) continue;
      let outcome: Outcome;
      try {
        outcome = await evaluate(source, fresh);
      } catch (error) {
        state.problems.add(
          `display "${key}": the value component "${decl.id}" (${decl.module}) did not load to read its label: ${(error as Error).message}`,
        );
        continue;
      }
      state.exports.set(decl.id, outcome.has);
      if (!outcome.has) {
        const said = rule.values !== undefined || rule.humanize !== undefined;
        if (vocabulary.length && !said)
          state.warnings.add(
            `display "${key}" [value-words-missing]: "${decl.id}" draws "${column}" but nothing says its words, so breakdowns, chips and the CSV show the stored values. ` +
              `Export a label(value) from ${decl.module}, or declare values.`,
          );
        continue;
      }
      if (!vocabulary.length) {
        state.warnings.add(
          `display "${key}" [value-label-open]: ${decl.module} exports label, but "${column}" has no vocabulary to call it over (a free-text column), so it is not used. ` +
            `Declare values for the known words, or constrain the column.`,
        );
        continue;
      }
      const words = (holder[key] ??= {});
      for (const { value, word, error } of outcome.said) {
        state.asked.add(`${key}\n${value}`);
        const where = `display "${key}" [value-label]: label(${JSON.stringify(value)}) in ${decl.module}`;
        if (error) state.problems.add(`${where} ${error}.`);
        else if (typeof word !== 'string' || !word.trim())
          state.problems.add(
            `${where} returned ${word === '' ? 'an empty string' : 'something other than text'}; it returns the word to say.`,
          );
        else if (word.length > MAX_LABEL)
          state.problems.add(`${where} returned ${word.length} characters; a word is at most ${MAX_LABEL}.`);
        else words[value] = word;
      }
    }
  }
}

/** What learning found wrong with a load's labels (they refuse `check`), and what it advises. */
export function valueLabelFindings(app: AppDef): {
  problems: string[];
  warnings: string[];
} {
  const state = app.valueLabels && learned.get(app.valueLabels);
  return {
    problems: [...(state?.problems ?? [])],
    warnings: [...(state?.warnings ?? [])],
  };
}
