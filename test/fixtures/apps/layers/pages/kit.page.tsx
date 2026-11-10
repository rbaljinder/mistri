/**
 * One of each house control a free-form page draws, and a layer over the page (`?show=drawer|modal|popover`). The page's
 * own stylesheet styles a `dl` that sits inside the layer, and a page child at `z-index: 9` is what the layer must paint
 * over: e2e/page-layers.spec.ts asks for the backdrop, the close control, that class applying and the stacking.
 */
import {
  Card,
  Drawer,
  Icon,
  Modal,
  Pagination,
  Popover,
  Search,
  Segmented,
  Select,
  Stack,
  Stat,
  TextField,
  definePage,
  useHref,
} from '@mistriwork/mistri/page';
import { useState } from '@mistriwork/mistri/ui';
import './kit.css';

const page = definePage({
  label: 'Kit',
  reads: ['thing'],
  params: { show: ['none', 'drawer', 'modal', 'popover'], view: ['lanes', 'board'], search: 'text' },
  component: Kit,
});
export default page;

function Facts() {
  return (
    <dl className="c-page-kit-facts">
      <dt>Anvil</dt>
      <dd>Heavy</dd>
    </dl>
  );
}

function Kit() {
  const [show, setShow] = page.useParam('show');
  const href = useHref();
  const [name, setName] = useState('');
  const [pick, setPick] = useState('a');
  const [tab, setTab] = useState('x');
  const [at, setAt] = useState(1);
  const close = () => setShow('none');
  return (
    <div className="c-page-kit">
      {/* A positioned child with a z-index of its own: a layer is above it, whatever it says. */}
      <div className="c-page-kit-raised">Raised page child</div>
      <p>
        Back to{' '}
        <a className="c-page-kit-link" href={href.page('kit')}>
          the kit
        </a>
        , or on.
      </p>
      <Stack>
        <Segmented
          label="Size"
          size="compact"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'x', label: 'One' },
            { value: 'y', label: 'Two' },
          ]}
        />
        <page.Choose param="view" />
        <Search param="search" />
        <Card title="Totals">
          <Stat label="Things" value="3" />
        </Card>
        <TextField label="Name" value={name} onChange={setName} />
        <Select
          label="Kind"
          value={pick}
          onChange={setPick}
          options={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ]}
        />
        <Pagination page={at} pages={9} onPageChange={setAt} />
        <div className="c-page-kit-narrow">
          <Pagination page={5} pages={9} onPageChange={setAt} ariaLabel="Narrow pages" />
        </div>
        <Icon name="caret-left" />
        <Popover
          trigger={
            <button type="button" className="c-page-kit-open">
              Open popover
            </button>
          }
          open={show === 'popover'}
          onOpenChange={(open) => setShow(open ? 'popover' : 'none')}
        >
          <Facts />
        </Popover>
      </Stack>
      <Drawer open={show === 'drawer'} title="Details" onOpenChange={(open) => !open && close()}>
        <Facts />
      </Drawer>
      {show === 'modal' && (
        <Modal className="c-page-kit-modal" onClose={close}>
          <h2>Details</h2>
          <Facts />
        </Modal>
      )}
    </div>
  );
}
