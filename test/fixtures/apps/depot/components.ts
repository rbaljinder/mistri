import { component } from '@mistriwork/mistri/app';

/* Depot's own components, declared as data: a name and a module path each.
   Where each is placed says what it reads; the modules draw with
   @mistriwork/mistri/ui. The pick walk, which moves stock through the Pick command,
   is a page of its own (pages/pick-walk.page.tsx). */

/** A warehouse's pick face as the floor sees it: aisles of bays and levels, each bin shaded by how full it is. */
export const binMap = component('bin-map', { module: './widgets/BinMap.tsx' });

/** On hand, and the last thirty days of it as a line beside the figure. */
export const stockSparkline = component('stock-sparkline', { module: './widgets/StockSparkline.tsx', kind: 'value' });
