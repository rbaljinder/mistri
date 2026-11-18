/*
 * The AI proposals fixture's two commands, and its `--commands` entry. Server-only.
 * `sendAppeal` is declared for AI to propose (`approval: 'ai'`); `closeClaim` is
 * proposed only because the assistant runs it. Either way the run waits for a person.
 */
import { defineCommand, defineCommands, defineSource, field, id, int, literal, shape } from '@mistriwork/mistri/commands';

type Rows = { claim: { id: number; name: string; status: string; note: string | null; version: number } };
const claims = defineSource<Rows>('claims');

const output = shape({ claimId: id(), version: int({ min: 1 }), message: literal('Claim updated.') });

export default defineCommands({
  sendAppeal: defineCommand({
    approval: 'ai',
    source: claims,
    target: 'claim',
    input: { note: field.text({ max: 200 }) },
    output,
    async handle({ db, record }, input) {
      const claim = await db.claim.update(record, { status: 'appealed', note: input.note });
      return { claimId: claim.id, version: claim.version, message: 'Claim updated.' as const };
    },
  }),
  closeClaim: defineCommand({
    source: claims,
    target: 'claim',
    input: {},
    output,
    async handle({ db, record }) {
      const claim = await db.claim.update(record, { status: 'closed' });
      return { claimId: claim.id, version: claim.version, message: 'Claim updated.' as const };
    },
  }),
});
