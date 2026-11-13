/**
 * A public form's choices from a table, served with the form (`GET /api/forms/<key>`), so the page draws them with
 * no read of its own and the answer revalidates under one ETag: the form, its options and all. Read through the
 * shared cache (choiceCache.ts) as the public principal reads them — an ordinary App's public read is every row, of
 * the key and label columns the App's check proved `auth.public` opens (savedFormChecks.ts `public-form-picker`).
 *
 * Only an ordinary App's: a row-policy or tenant App's visitor reads its choices per request through its own scoped
 * read (`/api/run`), and its form is served without them.
 */
import type { AppCommandField } from '../../../schema/command.js';
import { choiceAnswers, choiceLabelColumn, choiceWhereColumns, type AppFormCommandReference } from '../../shared/command.js';
import { isRowPolicyApp, isTenantApp, logicalResource, type AppDef } from '../../shared/app.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { choiceColumns, choiceNarrowing, choiceOrder, choiceReadLimit, sharedChoices } from './choiceCache.js';

type Sourced = Extract<AppCommandField, { type: 'choice' | 'choices' }> & {
  source: NonNullable<Extract<AppCommandField, { type: 'choice' }>['source']>;
};
const sourced = (field: AppCommandField): field is Sourced =>
  (field.type === 'choice' || field.type === 'choices') && field.source !== undefined;

/** Whether the App's choices may be shared at all: an ordinary App's, never a row policy's or a tenant's. */
const sharesChoices = (app: AppDef): boolean => !isRowPolicyApp(app) && !isTenantApp(app);

/**
 * The fields of a served form with each choice from a table given its rows as `options` (its `source` kept, so the
 * page knows them for what they are). A field whose rows could not be read is left as it was, and the page reads
 * them itself, as it did before.
 */
export async function withTableChoices(options: {
  registry: Registry;
  app: AppDef;
  connection: string;
  commands: BusinessCommandRegistry | undefined;
  /** The commands whose inputs the form serves, in its order: a saved form's steps' and its submit's. */
  owners: readonly string[];
  input: readonly AppCommandField[];
  /** The reader's locale: a field naming a column for it (`labelColumns`) is said by that column. */
  locale?: string;
}): Promise<AppCommandField[]> {
  const { registry, app, connection } = options;
  const input = [...options.input];
  if (!sharesChoices(app) || !input.some(sourced)) return input;
  /* Which command declared a field, for its source: the field's `from` is a table of that command's source. */
  const sourceOf = (name: string): string | undefined => {
    for (const id of options.owners) {
      const command = options.commands?.[id];
      if (command?.fields.some((field) => field.name === name)) return command.source;
    }
    return undefined;
  };
  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner)));
    return await Promise.all(
      input.map(async (field) => {
        if (!sourced(field)) return field;
        try {
          const source = sourceOf(field.name);
          const resource = source === undefined ? field.source.from : logicalResource(app, source, field.source.from);
          /* A table the public opens only by a record's key is never listed (publicByKey.ts), and this read is not
             through that fence: its field is left as it was, so the page's own read, which is, finds it refused. */
          if (app.auth?.public?.byKey?.includes(resource)) return field;
          const physical = resources.toPhysical(resource);
          const owner = resources.connectionFor(resource);
          const local = choiceLabelColumn(field.source, options.locale);
          const where = choiceWhereColumns(field.source.match);
          const narrowing = choiceNarrowing(field.source.match);
          const read = { by: field.source.by, labelColumn: field.source.labelColumn, sort: field.source.sort, local, where, narrowing };
          const choices = await sharedChoices({
            registry,
            appId: app.id,
            connection: owner,
            source: { resource, physical, ...read },
            read: async () =>
              (
                await resources.forConnection(owner).query({
                  table: resource,
                  columns: choiceColumns(read),
                  ...(narrowing.filter ? { filter: narrowing.filter } : {}),
                  ...(narrowing.lanes ? { lanes: narrowing.lanes } : {}),
                  orderBy: choiceOrder(field.source),
                  limit: choiceReadLimit(narrowing),
                  offset: 0,
                })
              ).rows,
          });
          /* Cut, and narrowed by an answer the served rows could not all be read for: the field is left as it was, so the
             page reads it itself with the answer bound (IntakeControls.tsx useSourced), each answer its own rows. */
          if (choices.cut && field.source.match && choiceAnswers(field.source.match).length) return field;
          return {
            ...field,
            source: { ...field.source, served: true },
            /* A field that narrows by other answers keeps each row's `where` columns: the page filters as they change,
               with no read of its own. */
            options: choices.options.map((option) => ({
              value: option.value,
              label: option.label,
              ...(option.row ? { row: option.row } : {}),
            })),
          } as AppCommandField;
        } catch {
          return field;
        }
      }),
    );
  } catch {
    return input;
  } finally {
    for (const release of releases) release();
  }
}

/**
 * A public page's public commands (`definePage({ public: true, commands })`, commandContracts.ts publicPageCommands)
 * with each choice from a table given its rows, as a public form's are: read through the same shared cache as the
 * public principal reads them, whoever asks, since the page's door runs them as that principal. The check proved
 * `auth.public` opens each one's key and label (savedFormChecks.ts `public-form-picker`), and the App's payload they
 * ride in is revalidated, so a change to the rows is a new tag.
 */
export async function withPublicCommandChoices(
  served: Readonly<Record<string, AppFormCommandReference>>,
  options: {
    registry: Registry;
    app: AppDef;
    connection: string | undefined;
    commands: BusinessCommandRegistry | undefined;
    locale?: string;
  },
): Promise<Record<string, AppFormCommandReference>> {
  const { connection, ...rest } = options;
  const entries = Object.entries(served);
  if (connection === undefined || !entries.some(([, reference]) => reference.input.some(sourced))) return { ...served };
  return Object.fromEntries(
    await Promise.all(
      entries.map(
        async ([id, reference]) =>
          [
            id,
            reference.input.some(sourced)
              ? { ...reference, input: await withTableChoices({ ...rest, connection, owners: [id], input: reference.input }) }
              : reference,
          ] as const,
      ),
    ),
  );
}
