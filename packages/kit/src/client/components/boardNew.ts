/**
 * The New form a list offers, handed to its board so each lane's head can
 * offer a record in that lane. A context rather than a prop: the list (AppList)
 * and its board (BoardList) are four components apart, and only an App's own
 * list room provides one — an embedded or dashboard board offers no New.
 */
import { createContext } from 'react';
import type { FormSpec } from './NewRecordButton.js';

export const BoardNewForm = createContext<FormSpec | null>(null);

/**
 * How many cards a board holds across its lanes, said back to the list that drew it: a board reads no total of its
 * own (it counts its lanes in one breakdown), so the count beside the room's title is the lanes' sum.
 */
export const BoardTotal = createContext<((total: number | null) => void) | null>(null);
