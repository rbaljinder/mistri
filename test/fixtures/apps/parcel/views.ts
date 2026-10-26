import { listView } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';

/* Everything a Parcel reader can open. navigation.ts arranges them.

   Every question here is one the API documents (see its description in
   test/fixtures/apps/parcel/source): the tabs filter by `status`, the filters are
   the three parameters the API takes, and the one sort is `eta`, a value its
   `sort` parameter lists. A question it does not document — "status != …",
   "contains", a sort by another column — is refused with what it can do,
   rather than answered from rows fetched and filtered here. */
export const views = {
  shipments: listView('Shipments', 'shipments', {
    // The carrier by name: a label path through `carrier_id`, read once per carrier from its item path.
    show: ['tracking_number', 'status', 'carrier_id.name', 'destination_city', 'destination_state', 'eta'],
    filters: ['status', 'carrier_id', 'destination_state'],
    tabs: [
      { segment: 'on_the_way', sort: 'eta' },
      'out_for_delivery',
      'held',
      'delivered',
      // The API's own order: most recently shipped first.
      { label: 'All' },
    ],
  }),
  carriers: listView('Carriers', 'carriers', {
    show: ['name', 'headquarters', 'phone', 'on_time_rate', 'active'],
    // The carriers endpoint takes no filters, so there are no boxes to offer.
    filterBar: 'none',
  }),
} satisfies Views;
