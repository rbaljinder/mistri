import { defineCommand, defineCommands, defineSource, literal, refuse, shape } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

const source = defineSource<Rows>('payday');

/* The one handler Payday needs. Submitting and approving a run, declining a
   request, approving timesheets and sending a reminder only set a status and
   stamp who and when, so they are fixed verbs and actions granted by name (features/).
   Approving time off does more: it spends the request's hours from the
   teammate's balance for its policy, in the same transaction as the status
   change, so the balance and the approved requests cannot disagree. A
   request the balance cannot cover is refused, saying what is left, rather
   than driven negative; the request's revision guards a second approval,
   and its machine (features/timeoff.ts) runs it only on a pending one. */
export const approveTimeOff = defineCommand({
  source,
  target: 'time_off',
  read: ['time_off', 'time_off_balance', 'employee', 'time_off_policy'],
  write: ['time_off', 'time_off_balance'],
  output: shape({ message: literal('Time off approved.') }),
  async handle({ db, record }) {
    const balance = await db.time_off_balance.find({ employee_id: record.employee_id, policy_id: record.policy_id });
    const hours = Number(record.hours);
    if (!balance || Number(balance.available_hours) < hours) {
      const person = await db.employee.get({ id: record.employee_id });
      const policy = await db.time_off_policy.get({ id: record.policy_id });
      refuse(`${person.name} has ${Number(balance?.available_hours ?? 0)} h of ${policy.name} left, and this request is ${hours} h.`);
    }
    await db.time_off_balance.update(balance, {
      used_hours: Number(balance.used_hours) + hours,
      available_hours: Number(balance.available_hours) - hours,
    });
    await db.time_off.update(record, { status: 'approved' });
    return { message: 'Time off approved.' as const };
  },
});

export default defineCommands({ approveTimeOff });
