import { chart, custom, fields, metric, page, related } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';
import { binMap } from '../components.ts';

/* The floor at a glance, drawn by Depot's own bin map (widgets/BinMap.tsx):
   every bin of the building by where its code puts it, shaded by how full it
   is. Its one read is the building's bins, planned like the Bins list below;
   exported so the map can type its rows from it. */
export const warehouseBins = custom('Floor', binMap, {
  rows: {
    bins: { from: 'bin', whose: 'warehouse_id', show: ['id', 'code', 'zone', 'capacity', 'units', 'active'], sort: 'code', limit: 500 },
  },
});

/* The buildings, from the top down: a warehouse, one of its bins, one SKU's
   stock in a bin, and a cycle count with its lines. */
export const warehousePages = {
  warehouse: page(
    'warehouse',
    [
      fields(['code', 'city', 'state', 'manager'], { presentation: 'facts' }),
      /* Three figures: beside the side menu and the aside, a desk holds three to a
       row. What is to pick has its own count and list further down. */
      fields(['stock_value', 'units', 'stocked']),
      warehouseBins,
      chart('Units moved by day', 'stock_movement', 'day moved_at, kind', {
        whose: 'warehouse_id',
        shape: 'stacked',
        query: 'moved_at = last 30 days and kind != "count"',
        height: 200,
      }),
      chart('Stock value by zone', 'stock_level', 'bin_id.zone', {
        whose: 'warehouse_id',
        shape: 'donut',
        measure: 'sum value',
        width: 'half',
      }),
      metric('Pick lists to pick', 'pick_list', { whose: 'warehouse_id', query: 'status = to_pick', width: 'half' }),
      related('Pick lists to pick', 'pick_list', 'warehouse_id', {
        query: 'status = to_pick',
        show: ['reference', 'ship_to', 'sales_order_id.ship_by', 'sales_order_id.priority'],
        sort: 'released_at',
      }),
      related('Bins', 'bin', 'warehouse_id', { show: ['code', 'zone', 'units', 'skus'], sort: 'code', limit: 25 }),
      related('Cycle counts', 'cycle_count', 'warehouse_id', {
        show: ['id', 'status', 'started_on', 'variance_value'],
        sort: 'started_on desc',
        limit: 10,
      }),
      fields(['address', 'city', 'state', 'phone', 'manager', 'dock_doors', 'bins'], { title: 'Building', region: 'aside' }),
    ],
    { listTabs: true },
  ),
  bin: page(
    'bin',
    [
      fields(['warehouse_id.name', 'zone', 'aisle'], { presentation: 'facts' }),
      fields(['units', 'skus', 'value']),
      related('In this bin', 'stock_level', 'bin_id', {
        show: ['product_id.sku', 'product_id', 'qty', 'value'],
        sort: 'qty desc',
      }),
      related('Movements', 'stock_movement', 'bin_id', {
        show: ['moved_at', 'kind', 'product_id.sku', 'qty'],
        sort: 'moved_at desc',
        limit: 15,
      }),
      fields(['warehouse_id', 'code', 'aisle', 'zone', 'capacity', 'active'], { title: 'Bin', region: 'aside' }),
    ],
    { listTabs: true },
  ),
  'stock-level': page(
    'stock_level',
    [
      fields(['product_id', 'qty', 'value']),
      related(
        'Ledger for this bin',
        'stock_movement',
        { same: ['product_id', 'bin_id'] },
        {
          show: ['moved_at', 'kind', 'qty', 'bin_qty_after'],
          sort: 'moved_at desc',
          limit: 20,
        },
      ),
      related(
        'Elsewhere',
        'stock_level',
        { same: ['product_id'] },
        {
          show: ['bin_id', 'warehouse_id', 'qty'],
          sort: 'qty desc',
          empty: 'hide',
        },
      ),
      fields(['bin_id', 'warehouse_id', 'bin_id.zone', 'last_counted_on', 'product_id.reorder_point', 'product_id.home_bin_id'], {
        title: 'Location',
        region: 'aside',
      }),
    ],
    { listTabs: true },
  ),
  'cycle-count': page('cycle_count', [
    // No aside: a count is read line by line, and its seven columns want the page's width.
    fields(['warehouse_id', 'aisle', 'started_on', 'completed_on', 'status']),
    fields(['lines', 'counted', 'variance_units', 'variance_value'], { title: 'Progress' }),
    fields(['note'], { title: 'Note', columns: 1, when: 'note is not empty' }),
    related('Lines', 'cycle_count_line', 'cycle_count_id', {
      show: ['bin_id', 'product_id.sku', 'product_id', 'expected_qty', 'counted_qty', 'variance', 'variance_value'],
      sort: 'bin_id.code',
      limit: 60,
    }),
  ]),
  'count-line': page('cycle_count_line', [
    fields(['bin_id', 'product_id', 'counted_qty'], { columns: 3 }),
    fields(['cycle_count_id', 'product_id.sku', 'cycle_count_id.status'], { title: 'Count', presentation: 'properties' }),
  ]),
} satisfies Pages;
