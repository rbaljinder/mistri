/**
 * The floor's work at a glance: every open pick list as a card in the lane of its stage — to pick, picked, packed —
 * and, above the board, the next lists to pick with a Pick each, first to ship first. The board is the
 * pick-list machine drawn whole; the list is the one stage a picker moves, made for a thumb, since a phone shows the
 * board one lane at a time.
 *
 * A free-form page from blocks alone: Choose keeps the warehouse in the address (`?warehouse=2`), and one Scope says
 * "this warehouse's open lists" once for both. Its one change is Pick (`pickList`), refused in the server's words when
 * stock is short — from the button, or by dropping a card from To pick onto Picked. Packing and shipping keep their
 * forms on the pick list's page, so the board offers no other move.
 */
import type { ReactNode } from 'react';
import { Board, Choose, CommandButton, definePage, Empty, Grid, List, Panel, Scope, Stack, useFormat } from '@mistriwork/mistri/page';
import './pick-board.css';

const page = definePage({
  label: 'Pick board',
  description: 'Open pick lists by stage, with the next ones to pick.',
  icon: 'kanban',
  nav: { group: 'floor', position: 2 },
  // The floor's page: a purchaser reads pick lists elsewhere and runs none of them.
  roles: ['operator', 'manager', 'admin'],
  reads: ['pick_list', 'sales_order', 'warehouse'],
  commands: ['pickList'],
  params: { warehouse: 'id' },
  component: PickBoard,
});
export default page;

function PickBoard(): ReactNode {
  const format = useFormat();
  const [warehouse] = page.useParam('warehouse');
  const day = (on: string) => format.relative(on) ?? format.date(on);
  return (
    <Stack>
      <Choose param="warehouse" name="Warehouse" all="All warehouses" from="warehouse" sort="name" label="name" />
      <Scope from="pick_list" where={{ status: { not: 'shipped' }, ...(warehouse === undefined ? {} : { warehouse_id: warehouse }) }}>
        <Grid>
          <Panel title="Next to pick" width="full">
            <List
              where={{ status: 'to_pick' }}
              show={['reference', 'ship_to', 'sales_order_id.ship_by', 'warehouse_id.name']}
              sort="sales_order_id.ship_by, released_at"
              limit={5}
              label="Next to pick"
              empty={<Empty title="Nothing to pick" description="Released orders arrive here as pick lists." />}
            >
              {(list) => (
                <div className="c-page-pick-board-next">
                  <p>
                    <strong>{list.reference}</strong> · {list.ship_to}
                    <span>
                      {list['sales_order_id.ship_by'] && `Ships ${day(list['sales_order_id.ship_by'])} · `}
                      {list['warehouse_id.name']}
                    </span>
                  </p>
                  <CommandButton command="pickList" row={list} done={`${list.reference} is picked. It waits in To pack.`} />
                </div>
              )}
            </List>
          </Panel>
          <Panel title="By stage" width="full">
            <Board
              by="status"
              primary="reference"
              lines={['ship_to']}
              footer={[{ column: 'released_at', icon: 'calendar' }]}
              sort="sales_order_id.ship_by, released_at"
              limit={200}
              folded={['shipped']}
              move={['pickList']}
              label="Open pick lists by stage"
            />
          </Panel>
        </Grid>
      </Scope>
    </Stack>
  );
}
