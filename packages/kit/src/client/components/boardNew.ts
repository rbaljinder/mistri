/**
 * The New form a list offers, handed to its board so each lane's head can
 * offer a record in that lane. A context rather than a prop: the list (AppList)
 * and its board (BoardList) are four components apart, and only an App's own
 * list room provides one — an embedded or dashboard board offers no New.
 */
import { createContext } from 'react';
import type { FormSpec } from './NewRecordButton.js';

export const BoardNewForm = createContext<FormSpec | null>(null);
