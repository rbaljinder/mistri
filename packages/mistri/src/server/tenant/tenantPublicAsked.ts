/**
 * A tenant App's public form served with the inputs its placing tenant asks (`when: 'tenant.country = "US"'`), as a
 * signed-in form is told them by prepare (commands/commandPrepare.ts). A public form is never prepared, so its read
 * judges the `tenant.` parts of each input's `when` here, against the shared profile (`auth.tenancy.shared`) of the
 * tenant its address places — the same values its submission is judged by (tenantIntake.ts), so the page never asks
 * what the run would refuse. An input that never holds is not served; one that always holds is served with no `when`;
 * the rest keep what is left over the draft. The browser is told which inputs are asked, never a profile value.
 *
 * An address that places nobody — unknown, the platform's triage — places no profile, and every `tenant.` part fails,
 * as it does on the submission.
 */
import type { AppCommandField } from '../../../schema/command.js';
import type { TenantValue } from '@mistriwork/engine/shared/queryOperands.js';
import { bindRecord, boundText, readsRecord } from '../../shared/commandDraft.js';

type Profile = Readonly<Record<string, TenantValue>>;
type Asked = Exclude<AppCommandField, { type: 'group' }> & { when: string };

/** The served inputs, judged by the placing tenant's profile, read only where an input asks by it; the same array where
    none does. */
export async function tenantPublicAsked(input: AppCommandField[], placed: () => Promise<Profile | undefined>): Promise<AppCommandField[]> {
  if (!input.some(asksTenant)) return input;
  const profile = await placed();
  const now = new Date();
  const served: AppCommandField[] = [];
  for (const field of input) {
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
