// Private account commands. The policy scopes saved_vehicle to the verified
// actor, so these handlers never accept an account id from browser input.
import { defineCommand, literal, shape } from '@mistriwork/mistri/commands';
import { market } from './market.ts';

export const saveVehicle = defineCommand({
  source: market,
  target: 'vehicle',
  write: ['saved_vehicle'],
  output: shape({ message: literal('Vehicle saved.') }),
  async handle({ db, record, actor, now }) {
    const saved = await db.saved_vehicle.find({ account_id: actor.id, vehicle_id: record.id });
    if (saved?.active) return { message: 'Vehicle saved.' as const };
    if (saved) await db.saved_vehicle.update(saved, { active: true });
    else await db.saved_vehicle.insert({ account_id: actor.id, vehicle_id: record.id, active: true, saved_at: now().toISOString() });
    return { message: 'Vehicle saved.' as const };
  },
});

export const removeSavedVehicle = defineCommand({
  source: market,
  target: 'saved_vehicle',
  read: ['vehicle'],
  when: 'active = true',
  output: shape({ message: literal('Vehicle removed from your shortlist.') }),
  async handle({ db, record }) {
    await db.saved_vehicle.update(record, { active: false });
    return { message: 'Vehicle removed from your shortlist.' as const };
  },
});
