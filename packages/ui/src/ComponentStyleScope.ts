/** React portals keep their component's scoped stylesheet without widening it
 * to other Apps or dialogs. The compiler still bounds CSS by data-component. */
import { createContext } from 'react';
export const ComponentStyleScope = createContext<string | undefined>(undefined);
