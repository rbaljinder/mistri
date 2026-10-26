/**
 * The pick walk's examples, on a phone: the lists waiting, a line of a list
 * mid-walk, and the end of the walk with Pick. Storybook draws each as a
 * story, and pick-walk.test.tsx walks the same page.
 */
import { example, examples, fixtures } from '@mistriwork/mistri/ui/testing';
import page from './pick-walk.page.tsx';

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/* What the page's loader (pickWalk, commands.ts) answers for these lists. */
const loaded = {
  lists: [
    {
      id: 25189,
      reference: 'SO-25189',
      shipTo: 'North Woods Outfitting, Duluth, MN',
      warehouse: 'Columbus',
      shipBy: inDays(2),
      rush: true,
    },
    { id: 25184, reference: 'SO-25184', shipTo: 'Cascade Camp & Climb, Bellingham, WA', warehouse: 'Reno', shipBy: inDays(5), rush: false },
  ],
};

export const data = fixtures({
  pick_list: [
    { id: 25189, reference: 'SO-25189', ship_to: 'North Woods Outfitting, Duluth, MN', sales_order_id: 25189, status: 'to_pick' },
    { id: 25184, reference: 'SO-25184', ship_to: 'Cascade Camp & Climb, Bellingham, WA', sales_order_id: 25184, status: 'to_pick' },
  ],
  order_line: [
    { id: 1, qty: 2, 'bin_id.code': 'CMH-A-03-1', 'product_id.sku': 'BSE-M2C-PLM-L', 'product_id.name': 'Merino 200 Crew, L — Plum' },
    { id: 2, qty: 1, 'bin_id.code': 'CMH-A-10-2', 'product_id.sku': 'H2O-B1L-TEA', 'product_id.name': 'Trail Bottle 1 L — Teal' },
    { id: 3, qty: 4, 'bin_id.code': 'CMH-C-07-3', 'product_id.sku': 'GLV-LNR-BLK-M', 'product_id.name': 'Trail Liner Glove, M — Black' },
  ],
});
const floor = { viewer: { signedIn: true, account: 'picker' }, commands: { pickList: { label: 'Pick' } } };

export default examples(page, page.definition, { data, loaded, width: 360, ...floor });

/** The lists waiting, first to ship first. */
export const Lists = example({});
/** A line mid-walk: its bin in big type, what to take. */
export const Line = example({ address: { list: '25189', line: '1' }, mode: 'dark' });
/** Every line picked: the Pick command. */
export const Done = example({ address: { list: '25189', line: '3' } });
