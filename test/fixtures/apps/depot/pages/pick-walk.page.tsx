/**
 * A pick list walked on a phone. First the lists waiting to be picked, first
 * to ship first; then the chosen list one line at a time in bin order — the
 * bin in big type, the SKU, the product and how many — each confirmed with
 * "Picked ✓"; and, once every line is, the Pick command, which takes the
 * units off the shelves in the ledger and moves the list to packing.
 *
 * A free-form page: the lists waiting arrive with it from its loader
 * (`pickWalk` in commands.ts, run on the server as the reader); the chosen
 * list and its lines are read through the page's hooks, within the reads it
 * declares; and it keeps its place in the address (`?list=12&line=3`), so a
 * reload, a dropped signal or Back lands where the picker was. Its one
 * change is the Pick command, refused in the server's words when stock is
 * short; nothing here writes.
 */
import type { ReactNode } from 'react';
import { Button, definePage, Empty, Stack, type PageProps } from '@mistriwork/mistri/page';
import { useFormat, useState } from '@mistriwork/mistri/ui';
import './pick-walk.css';

const page = definePage({
  label: 'Pick walk',
  description: 'Choose a list, then walk it: each line in bin order, confirmed as it goes into the tote.',
  icon: 'list-checks',
  nav: { group: 'floor', position: 1 },
  reads: ['pick_list', 'order_line', 'warehouse', 'sales_order', 'bin', 'product'],
  commands: ['pickList'],
  params: ['list', 'line'],
  loader: 'pickWalk',
  component: PickWalk,
});
export default page;

type Row = Readonly<Record<string, unknown>>;
type Waiting = PageProps<'pickWalk'>['data']['lists'][number];

function Choose({ lists, onChoose }: { lists: readonly Waiting[]; onChoose: (list: Waiting) => void }): ReactNode {
  const format = useFormat();
  if (!lists.length) return <Empty title="Nothing to pick" description="Released orders arrive here as pick lists." />;
  return (
    <Stack as="ul" gap="tight" className="c-page-pick-walk-lists">
      {lists.map((list) => (
        <li key={String(list.id)}>
          <button type="button" className="c-page-pick-walk-list" onClick={() => onChoose(list)}>
            <span className="c-page-pick-walk-list-ref">{list.reference}</span>
            <span className="c-page-pick-walk-list-to">{list.shipTo}</span>
            <span className="c-page-pick-walk-list-meta">
              {list.warehouse ?? ''}
              {list.shipBy ? ` · ships ${format.relative(list.shipBy) ?? format.date(list.shipBy)}` : ''}
              {list.rush ? ' · rush' : ''}
            </span>
          </button>
        </li>
      ))}
    </Stack>
  );
}

function Walk({
  list,
  step,
  onStep,
  onDone,
  onLeave,
}: {
  list: Row;
  step: number;
  onStep: (next: number) => void;
  onDone: (message: string) => void;
  onLeave: () => void;
}): ReactNode {
  const format = useFormat();
  const pick = page.useCommand('pickList');
  const lines = page.useRows('order_line', {
    query: `sales_order_id = ${String(list.sales_order_id)}`,
    show: ['id', 'qty', 'bin_id.code', 'product_id.sku', 'product_id.name'],
    sort: 'bin_id.code, id',
    limit: 200,
  });
  if (lines.isPending)
    return (
      <p className="c-page-pick-walk-quiet" role="status">
        Reading the lines…
      </p>
    );
  if (lines.isError)
    return (
      <p className="c-page-pick-walk-quiet" role="alert">
        {lines.error?.message}
      </p>
    );
  const all = lines.data ?? [];
  const units = all.reduce((sum, line) => sum + Number(line.qty ?? 0), 0);
  const head = (
    <div className="c-page-pick-walk-head">
      <p className="c-page-pick-walk-ref">
        {String(list.reference)} · {String(list.ship_to)}
      </p>
      <Button intent="quiet" size="compact" onClick={onLeave}>
        All pick lists
      </Button>
    </div>
  );
  if (step < all.length) {
    const line = all[step];
    return (
      <div className="c-page-pick-walk">
        {head}
        <p className="c-page-pick-walk-progress" aria-live="polite">
          Line {step + 1} of {all.length}
        </p>
        <div className="c-page-pick-walk-progressbar" aria-hidden="true">
          <span style={{ width: `${(step / all.length) * 100}%` }} />
        </div>
        <article className="c-page-pick-walk-card" aria-label={`Line ${step + 1}`}>
          <p className="c-page-pick-walk-label">Bin</p>
          <p className="c-page-pick-walk-bin">{String(line['bin_id.code'] ?? 'Any bin')}</p>
          <p className="c-page-pick-walk-sku">{String(line['product_id.sku'] ?? '')}</p>
          <p className="c-page-pick-walk-name">{String(line['product_id.name'] ?? '')}</p>
          <p className="c-page-pick-walk-qty">
            <span className="c-page-pick-walk-label">Take</span> <strong>{format.number(Number(line.qty))}</strong>
          </p>
        </article>
        <div className="c-page-pick-walk-actions">
          <Button intent="primary" size="large" block onClick={() => onStep(step + 1)}>
            Picked ✓
          </Button>
          {step > 0 && (
            <Button intent="quiet" onClick={() => onStep(step - 1)}>
              Back a line
            </Button>
          )}
        </div>
      </div>
    );
  }
  const available = pick.available({ id: list.id });
  const busy = pick.pending({ id: list.id });
  return (
    <div className="c-page-pick-walk">
      {head}
      <article className="c-page-pick-walk-card c-page-pick-walk-done">
        <p className="c-page-pick-walk-bin">All {all.length} lines picked</p>
        <p className="c-page-pick-walk-name">
          {format.number(units)} units, in the tote. Pick takes them off the shelves and sends the list to packing.
        </p>
      </article>
      <div className="c-page-pick-walk-actions">
        {/* A reader who may not pick (a purchaser) walks the list and is offered no Pick. */}
        {pick.granted && (
          <Button
            intent="primary"
            size="large"
            block
            disabled={available !== true || busy}
            busy={busy}
            busyLabel="Picking…"
            onClick={() => {
              void pick.run({ id: list.id }, {}, { label: String(list.reference) }).then((outcome) => {
                if (outcome.status === 'applied') onDone(`${String(list.reference)} is picked. It waits in To pack.`);
              });
            }}
          >
            {pick.label}
          </Button>
        )}
        {pick.granted && available === false && <p className="c-page-pick-walk-quiet">This list is no longer waiting to be picked.</p>}
        <Button intent="quiet" onClick={() => onStep(Math.max(0, all.length - 1))}>
          Back a line
        </Button>
      </div>
    </div>
  );
}

function PickWalk({ data }: PageProps<'pickWalk'>): ReactNode {
  const [listId, setList] = page.useParam('list');
  const [line, setLine] = page.useParam('line');
  const chosen = page.useRows('pick_list', {
    query: `id = ${Number(listId)}`,
    show: ['id', 'reference', 'ship_to', 'sales_order_id', 'status'],
    limit: 1,
    enabled: listId !== undefined && /^\d+$/.test(listId),
  });
  const [said, setSaid] = useState('');
  /* A list starts at its first line: the line is reset, then the list is a step Back returns from. */
  const choose = (id: string | undefined) => {
    setLine(undefined);
    setList(id, { push: id !== undefined });
  };
  if (listId === undefined) {
    return (
      <div className="c-page-pick-walk">
        {said ? (
          <p className="c-page-pick-walk-said" role="status">
            {said}
          </p>
        ) : null}
        <Choose
          lists={data.lists}
          onChoose={(list) => {
            setSaid('');
            choose(String(list.id));
          }}
        />
      </div>
    );
  }
  if (chosen.isPending)
    return (
      <p className="c-page-pick-walk-quiet" role="status">
        Reading the pick list…
      </p>
    );
  const list = chosen.data?.[0];
  if (!list)
    return (
      <Empty
        title="That pick list is not here"
        action={
          <Button intent="secondary" onClick={() => choose(undefined)}>
            All pick lists
          </Button>
        }
      />
    );
  return (
    <Walk
      list={list}
      step={Number(line ?? 0) || 0}
      onStep={(next) => setLine(next)}
      onLeave={() => choose(undefined)}
      onDone={(message) => {
        setSaid(message);
        choose(undefined);
      }}
    />
  );
}
