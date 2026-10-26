/* The suggesting search box, as a part loaded on demand: every box that offers it names this one loader, and the
   first paint of a list or a landing carries none of it (SuggestBox.tsx). */
import { onDemand } from './onDemand.js';

export const SuggestBox = onDemand(() => import('./SuggestBox.js'), 'SuggestBox', { quiet: true });
