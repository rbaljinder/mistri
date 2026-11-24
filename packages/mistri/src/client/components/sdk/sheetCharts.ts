/**
 * The charts' stylesheets, and the first of the surface sheets in the cascade: `surfaces-base.css`, then
 * `surfaces-charts.css`.
 *
 * The surface sheets tie on specificity across files (the base's `.nx-card` and the primitives' refinements of it,
 * a primitive's part and the view that restyles it), so their order in the document is the cascade: base and charts,
 * then primitives, then views. A build links a chunk's stylesheet after the stylesheets of the chunks it imports,
 * and a chunk that holds nothing but a stylesheet is no chunk at all: its sheet is handed to whichever chunk asked,
 * and lands after everything that chunk imports. The list below is what makes this module a chunk of its own, which
 * the primitives' (sheetPrimitives.ts) imports, so its sheets are linked first whichever entry a page reaches first.
 * `scripts/bundle-budget.mjs` fails the build when the order is any other.
 */
import './surfaces-base.css';
import './surfaces-charts.css';

/** The surface sheets this page has asked for, in the order they stand in the cascade. */
export const SURFACE_SHEETS: string[] = ['base', 'charts'];
