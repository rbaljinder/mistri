/**
 * A tenant App's public form served with the inputs its placing tenant asks (`when: 'tenant.country = "US"'`), as a
 * signed-in form is told them by prepare (commands/commandPrepare.ts). A public form is never prepared, so its read
 * judges the `tenant.` parts of each input's `when` here, against the shared profile (`auth.tenancy.shared`) of the
 * tenant its address places — the same values its submission is judged by (tenantIntake.ts), so the page never asks
 * what the run would refuse. An input that never holds is not served; one that always holds is served with no `when`;
 * the rest keep what is left over the draft. A choice's options offered by the profile (an option's `when`) are judged
 * by it too: one withheld is not served, and the rest are served with no `when`. The browser is told which inputs and
 * options are asked, never a profile value.
 *
 * An address that places nobody — unknown, the platform's triage — places no profile, and every `tenant.` part fails,
 * as it does on the submission.
 */
import type { AppCommandField } from '../../../schema/command.js';
import type { TenantValue } from '@mistriwork/engine/shared/queryOperands.js';
import { bindRecord, boundText, readsRecord, withheldOptions } from '../../shared/commandDraft.js';

type Profile = Readonly<Record<string, TenantValue>>;
type Asked = Exclude<AppCommandField, { type: 'group' }> & { when: string };

/** The served inputs, judged by the placing tenant's profile, read only where an input asks by it; the same array where
    none does. */
export async function tenantPublicAsked(input: AppCommandField[], placed: () => Promise<Profile | undefined>): Promise<AppCommandField[]> {
  if (!input.some((field) => asksTenant(field) || offersByTenant(field))) return input;
  const profile = await placed();
  const now = new Date();
  const withheld = withheldOptions(input, profile ?? {});
  const served: AppCommandField[] = [];
  for (const offered of input) {
    const field = offersByTenant(offered) ? offeredBy(offered, withheld[offered.name] ?? []) : offered;
    if (!asksTenant(field)) {
      served.push(field);
      continue;
    }
    const text = boundText(await bindRecord(field.when, `input "${field.name}"`, async () => false, now, input, profile ?? {}));
    if (text === false) continue;
    if (text === true) {
      const { when: _when, ...rest } = field;
      served.push(rest as AppCommandField);
    } else served.push({ ...field, when: text } as AppCommandField);
  }
  return served;
}

const asksTenant = (field: AppCommandField): field is Asked =>
  field.type !== 'group' && field.type !== 'lines' && field.when !== undefined && readsRecord(field.when);

type Offering = Extract<AppCommandField, { type: 'choice' | 'choices' }>;

const offersByTenant = (field: AppCommandField): field is Offering =>
  (field.type === 'choice' || field.type === 'choices') && field.options.some((option) => option.when !== undefined);

// The field with its withheld options gone and its offered ones served with no `when`.
const offeredBy = (field: Offering, withheld: readonly (string | number)[]): AppCommandField => ({
  ...field,
  options: field.options
    .filter((option) => !withheld.includes(option.value))
    .map((option) => {
      if (option.when === undefined) return option;
      const { when: _when, ...rest } = option;
      return rest;
    }),
});
