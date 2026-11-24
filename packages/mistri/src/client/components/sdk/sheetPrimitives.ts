/**
 * The primitives' stylesheet, over the charts' (sheetCharts.ts says why each is a module of its own, and why this one
 * imports that one by a name it uses: the import is what puts the charts' sheet before this one in the document).
 * The views' entry imports this module and then its own sheet.
 */
import { SURFACE_SHEETS } from './sheetCharts.js';
import './surfaces-primitives.css';

SURFACE_SHEETS.push('primitives');
