// Server-only field shapes shared by the command handlers.
import { budget, person } from '../inputs.ts';

export const checkRateInput = { ...budget, ...person };

export const sendToDealerInput = {};
