import type { Pages } from '../mistri-schema.d.ts';
import { orderPages } from './orders.ts';
import { productPage } from './product.ts';
import { purchasingPages } from './purchasing.ts';
import { warehousePages } from './warehouse.ts';

export const pages = {
  product: productPage,
  ...purchasingPages,
  ...orderPages,
  ...warehousePages,
} satisfies Pages;
