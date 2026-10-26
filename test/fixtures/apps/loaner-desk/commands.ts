// Server-only: the App names these commands without importing this module.
import { defineCommand, defineCommands, defineSource, field, refuse, shape, text } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

const source = defineSource<Rows>('lending');
const said = shape({ message: text({ max: 300 }) });

export default defineCommands({
  checkoutEquipment: defineCommand({
    source,
    target: 'equipment',
    when: 'status = available',
    read: ['borrower'],
    write: ['equipment_loan'],
    input: {
      borrower: field.reference('borrower', { by: 'id', labelColumn: 'name', query: 'active = true' }),
      due_on: field.date({ help: 'Today or later, in UTC.' }),
    },
    output: said,
    async handle({ db, record, now }, input) {
      const today = now().toISOString().slice(0, 10);
      if (typeof input.borrower !== 'string') refuse('invalid_input', 'borrower');
      // The picker is advice: eligibility is checked again inside the transaction.
      const borrower = await db.borrower.find({ id: input.borrower, active: true });
      if (!borrower) refuse('Choose an active borrower before checking out this item.');
      if (input.due_on < today) refuse('The due date must be today or later.');
      if (await db.equipment_loan.find({ equipment_id: record.id, returned_on: null })) {
        refuse('This item already has an open loan. Return that loan before checking it out again.');
      }
      // Both writes and the receipt commit together. The partial unique index
      // protects one open loan even when another writer bypasses this handler.
      await db.equipment.update(record, { status: 'checked_out' });
      await db.equipment_loan.insert({
        equipment_id: record.id,
        borrower_id: borrower.id,
        status: 'open',
        checked_out_on: today,
        due_on: input.due_on,
        returned_on: null,
        version: 0,
      });
      return { message: `${record.name} checked out to ${borrower.name}.` };
    },
  }),
  returnEquipment: defineCommand({
    source,
    target: 'equipment_loan',
    when: 'status = open and returned_on is empty',
    write: ['equipment'],
    output: said,
    async handle({ db, record, now }) {
      const equipment = await db.equipment.get({ id: record.equipment_id });
      if (equipment.status !== 'checked_out') refuse('This item is not checked out. Check its loan before returning it.');
      const today = now().toISOString().slice(0, 10);
      if (today < record.checked_out_on) refuse('This loan starts in the future. Check its checkout date before returning it.');
      // Status and date move in the same statement to satisfy the loan CHECK.
      await db.equipment_loan.update(record, { status: 'returned', returned_on: today });
      await db.equipment.update(equipment, { status: 'available' });
      return { message: `${equipment.name} returned and available again.` };
    },
  }),
});
