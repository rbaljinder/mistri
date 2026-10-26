// A signed-in buyer's saved cars. policy.ts scopes saved_vehicle to the
// verified account, so these handlers never take an account id from the form.
import { defineCommand, literal, shape } from '@mistriwork/mistri/commands';
import { market, stamp } from './source.ts';

export const saveVehicle = defineCommand({
  source: market,
  target: 'vehicle',
  write: ['saved_vehicle'],
  output: shape({ message: literal('Saved.') }),
  async handle({ db, record, actor, now }) {
    const saved = await db.saved_vehicle.find({ account_id: actor.id, vehicle_id: record.id });
    if (saved?.active) return { message: 'Saved.' as const };
    if (saved) await db.saved_vehicle.update(saved, { active: true, saved_at: stamp(now) });
    else await db.saved_vehicle.insert({ account_id: actor.id, vehicle_id: record.id, active: true, saved_at: stamp(now) });
    return { message: 'Saved.' as const };
  },
});

export const removeSavedVehicle = defineCommand({
  source: market,
  target: 'saved_vehicle',
  targets: 'many',
  when: 'active = true',
  output: shape({ message: literal('Removed from your saved cars.') }),
  async handle({ db, records }) {
    for (const record of records) await db.saved_vehicle.update(record, { active: false });
    return { message: 'Removed from your saved cars.' as const };
  },
});
