import { defineEvent, id, shape } from '../../../../packages/mistri/src/server/commands.ts';

export const loanApplied = defineEvent('loan.applied', shape({ id: id() }));
