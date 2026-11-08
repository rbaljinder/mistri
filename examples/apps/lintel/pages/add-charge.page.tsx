/**
 * A one-off charge on a lease, asked a step at a time: what it is for, then how much and when it is due. A free-form
 * page at /add-charge?lease=3&step=amount. The lease is chosen first and kept in the address; the charge is the lease's
 * own Add charge command (commands/ledger.ts), its inputs, labels and rules, split over two steps by `<Steps>`.
 *
 * The command runs once, from the last step. Continue on the first only checks what that step asks, in the browser and
 * on the server, so a description past its length is said there and not after the amount. The step is a param too: a
 * reload, or the link a colleague was sent, opens the same step — or the first one not answered yet, since what was
 * typed stays in the page and never in the address.
 */
import type { ReactNode } from 'react';
import { Card, Choose, definePage, Empty, Stack } from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Add a charge',
  description: 'A one-off charge on a current lease: a repair a resident caused, a utility passed through.',
  icon: 'receipt',
  nav: { group: 'books', position: 3 },
  roles: ['manager', 'accountant'],
  reads: ['lease'],
  commands: ['addCharge'],
  params: { lease: 'id', step: ['what', 'amount'] },
  component: AddCharge,
});
export default page;

function AddCharge(): ReactNode {
  const [lease] = page.useParam('lease');
  return (
    <Stack gap="section">
      <Choose
        param="lease"
        from="lease"
        query="current"
        sort="unit_id"
        name="Lease"
        label="unit_id.code"
        empty={<Empty title="No current leases" description="A charge is added to a lease that is active or under notice." />}
      />
      {lease === undefined ? (
        <Card>
          <Empty title="Choose a lease" description="The charge is asked here a step at a time, and added to that lease." />
        </Card>
      ) : (
        <page.Steps
          command="addCharge"
          param="step"
          record={{ id: lease }}
          steps={[
            { id: 'what', label: 'What', title: 'What is the charge for?', inputs: ['kind', 'description'] },
            { id: 'amount', label: 'Amount', title: 'How much, and when is it due?', inputs: ['amount', 'due_on'] },
          ]}
        />
      )}
    </Stack>
  );
}
