/**
 * The column a list titles its rows by (`primary` on a list view), handed down to where the rows are read as
 * records. A record has one name everywhere (`recordLabel`); a list read by one person about their own things
 * often wants another: a patient's visits are titled by the therapist, not by the patient on every row.
 */
import { createContext, useContext } from 'react';

export const RowTitleContext = createContext<string | undefined>(undefined);

export function useRowTitle(): string | undefined {
  return useContext(RowTitleContext);
}
