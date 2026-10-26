/**
 * A split view's single keys (`shortcuts: { e: 'escalate' }`): the picked record's
 * header reads them from here, so the verb that a key runs shows it as a hint
 * and the key runs the verb through the same bar a click does.
 */
import { createContext } from 'react';

/** Key → action id. */
export const RecordKeys = createContext<Readonly<Record<string, string>>>({});
