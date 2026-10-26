/**
 * A tenant App's public form served with its choices from a table (`field.choice({ from })`), as an ordinary App's is
 * (forms/formChoices.ts), so the page draws them with no read of its own. A tenant's rows are that tenant's alone, so
 * the form's read is placed first, by the intake address its submission would land by (tenantPublicHttp.ts: the link's
 * `?via=`, or on this App's mapped host its tenant's own address), resolved exactly as the submission's is
 * (tenantIntake.ts `withPublicFlags`). The rows are then read as that tenant's
 * visitor reads them — the deployment's public owner, under `auth.public` and the policy's `resolvePublicRows`, never a
 * session or a membership — and kept per tenant (forms/choiceCache.ts `tenantChoices`).
 *
 * An address that places nobody — unknown, the platform's triage, a suspended tenant — and a read the public owner
 * refuses are answered alike: the field with no rows. No tenant's rows are ever offered under another's address.
 */
import type { AppCommandField } from '../../../schema/command.js';
import { logicalResource, type AppDef } from '../../shared/app.js';
import { formCommands } from '../../shared/appSavedForms.js';
import type { AppFormView } from '../../shared/app.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { CHOICE_ROWS_MOST, tenantChoices } from '../forms/choiceCache.js';
import { tenantChoiceTables, tenantLiveHub } from './tenantLive.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { PublicPlacement, PublicReadContext } from './tenantPublicReadRuntime.js';

type Sourced = Extract<AppCommandField, { type: 'choice' | 'choices' }> & {
  source: NonNullable<Extract<AppCommandField, { type: 'choice' }>['source']>;
};
const sourced = (field: AppCommandField): field is Sourced =>
  (field.type === 'choice' || field.type === 'choices') && field.source !== undefined;

interface TenantPublicChoicesOptions {
  readonly app: AppDef;
  readonly ownership: TenantOwnershipSnapshot;
  readonly commands?: BusinessCommandRegistry;
  readonly withPublicContext: <T>(placement: PublicPlacement, run: (context: PublicReadContext) => T | Promise<T>) => Promise<T>;
  /** The tenant an intake address places a form's submission with now, or null for none (the platform's triage). */
  readonly intakeTenant: (form: string, address: string) => Promise<string | null>;
}

/** The fields of a served form with each choice from a table given its rows, read for the tenant the request places. */
export function tenantPublicChoices(options: TenantPublicChoicesOptions) {
  const { app, ownership } = options;
  /* Which command declared a field, for its source: the field's `from` is a table of that command's source. */
  const resourceOf = (owners: readonly string[], field: Sourced): string => {
    for (const id of owners) {
      const command = options.commands?.[id];
      if (command?.fields.some((each) => each.name === field.name)) return logicalResource(app, command.source, field.source.from);
    }
    return field.source.from;
  };
  /* Placed as the submission is, by its address alone: no address, or one that places nobody, offers nothing. */
  const placed = async (form: string, address: string | undefined): Promise<string | null> => {
    if (!address) return null;
    try {
      return await options.intakeTenant(form, address);
    } catch {
      return null;
    }
  };
  return async (address: string | undefined, key: string, form: AppFormView, input: AppCommandField[]): Promise<AppCommandField[]> => {
    if (!input.some(sourced)) return input;
    const tenant = await placed(key, address);
    const owners = formCommands(form).map((reference) => reference.id);
    const hub = tenantLiveHub(ownership),
      tables = tenantChoiceTables(ownership);
    return Promise.all(
      input.map(async (field) => {
        if (!sourced(field)) return field;
        /* Served either way, so the page never reads them itself: a visitor's read on the shared host names no tenant. */
        const none = { ...field, source: { ...field.source, served: true }, options: [] } as AppCommandField;
        if (tenant === null) return none;
        try {
          const resource = resourceOf(owners, field);
          const physical = ownership.resources[resource];
          if (physical === undefined) return none;
          const columns = [...new Set([field.source.by, field.source.labelColumn])];
          const choices = await tenantChoices({
            hub,
            tables,
            appId: app.id,
            tenant,
            source: { resource, physical, by: field.source.by, labelColumn: field.source.labelColumn },
            read: () =>
              options.withPublicContext({ tenant }, async (context) => {
                const result = await context.data.query({
                  table: resource,
                  columns,
                  orderBy: [{ column: field.source.labelColumn, direction: 'asc' }],
                  limit: CHOICE_ROWS_MOST + 1,
                  offset: 0,
                });
                return result.rows;
              }),
          });
          return {
            ...field,
            source: { ...field.source, served: true },
            options: choices.options.map((option) => ({ value: option.value, label: option.label })),
          } as AppCommandField;
        } catch {
          return none;
        }
      }),
    );
  };
}
