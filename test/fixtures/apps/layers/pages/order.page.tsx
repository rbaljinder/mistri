/**
 * A list the reader orders and two lanes a card is carried between, built on the behaviors' public entry alone
 * (`@mistriwork/mistri/behaviors`): e2e/page-behaviors.spec.ts walks both with the keyboard and a pointer.
 */
import { useState } from 'react';
import { Sortable, SortableHandle, SortableItem, Transfer, TransferHandle, TransferItem, TransferList } from '@mistriwork/mistri/behaviors';
import { definePage } from '@mistriwork/mistri/page';
import './order.css';

const page = definePage({ label: 'Order', reads: ['thing'], component: Order });
export default page;

const NAMES: Record<string, string> = { measure: 'Measure', cut: 'Cut', sand: 'Sand', paint: 'Paint' };
const LANES: Record<string, string> = { todo: 'To do', done: 'Done' };

function Order() {
  const [steps, setSteps] = useState(['measure', 'cut', 'sand', 'paint']);
  const [lanes, setLanes] = useState<Record<string, string[]>>({ todo: ['measure', 'cut'], done: ['sand'] });
  const [said, setSaid] = useState('');
  return (
    <div className="c-page-order">
      <Sortable
        className="c-page-order-steps"
        by="handle"
        value={steps}
        onValueChange={(next, details) => {
          setSaid(`${details.reason} by ${details.source}`);
          setSteps(next);
        }}
        aria-label="Steps"
      >
        {(key) => (
          <SortableItem key={key} value={key} className="c-page-order-step">
            <SortableHandle aria-label={`Move ${NAMES[key]}`} />
            {NAMES[key]}
          </SortableItem>
        )}
      </Sortable>
      <p className="c-page-order-said" role="note">
        {said}
      </p>
      <Transfer
        className="c-page-order-lanes"
        value={lanes}
        onValueChange={setLanes}
        order={['todo', 'done']}
        label={(key) => NAMES[key]}
        listLabel={(lane) => LANES[lane]}
      >
        {Object.keys(LANES).map((lane) => (
          <section key={lane} className="c-page-order-lane">
            <h2>{LANES[lane]}</h2>
            <TransferList value={lane} aria-label={LANES[lane]} className="c-page-order-cards">
              {(key) => (
                <TransferItem key={key} value={key} className="c-page-order-card">
                  <TransferHandle aria-label={`Carry ${NAMES[key]}`} />
                  {NAMES[key]}
                </TransferItem>
              )}
            </TransferList>
          </section>
        ))}
      </Transfer>
    </div>
  );
}
