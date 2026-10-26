import { defineCommand, defineCommands, field, id, shape } from '../../../../packages/mistri/src/server/commands.ts';
import { loanApplied } from './events.mjs';

const applied = shape({ id: id() });
const decided = shape({ id: id() });

export default defineCommands({
  applyLoan: defineCommand({
    source: 'data',
    target: 'loan',
    targets: 'none',
    input: { ref: field.text({ max: 40 }) },
    output: applied,
    events: { applied: loanApplied },
    async handle({ db }, { ref }) {
      const row = await db.loan.insert({ ref, status: 'applied' });
      return { id: row.id };
    },
  }),
  approveLoan: defineCommand({
    source: 'data',
    target: 'loan',
    output: decided,
    async handle({ db, record }) {
      await db.loan.update(record, { status: 'approved' });
      return { id: record.id };
    },
  }),
});
