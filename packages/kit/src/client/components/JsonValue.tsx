/* Compact cells keep their text preview. Fetch the tree only for a full value. */
import { onDemand } from './onDemand.js';

export const JsonValue = onDemand(() => import('./JsonView.js'), 'JsonView');
