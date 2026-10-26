/* The shape `tablewalk --export types` would print for this fixture, kept
   beside seed.mjs, which is the schema: change one and change the other.
   Like the exporter, it names the App's rollups and computed columns with
   the table's columns, since a list, a field and a form read them alike. */
import type { TypedAppConfig } from '@mistriwork/mistri/app';

/** Every table, and every column it had when this file was written. */
export type Tables = {
  order_line: "id" | "order_id" | "position" | "product" | "quantity" | "unit_price" | "line_total";
  sales_order: "id" | "customer" | "currency" | "shipping" | "subtotal" | "total";
};

/** The app config with this schema’s own names: `satisfies App` on the default export. */
export type App = TypedAppConfig<Tables>;
