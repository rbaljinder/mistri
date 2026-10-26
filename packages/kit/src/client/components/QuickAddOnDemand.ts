/**
 * The quick-add row, loaded the first time a list that offers one is drawn.
 *
 * QuickAdd is the New form in a list's frame, and the form brings its field
 * library with it: most lists offer no quick add, and none of them should
 * wait for that library to show their rows. The list imports QuickAdd from
 * here; the component and its props are QuickAdd.tsx's own.
 */
import { onDemand } from './onDemand.js';

export const QuickAdd = onDemand(() => import('./QuickAdd.js'), 'QuickAdd', { quiet: true });
