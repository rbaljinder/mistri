/**
 * True for a list drawn beside an open detail pane. Its grid keeps to the
 * pane's width, leaving out the columns past it as an embedded grid does
 * (Grid's `dropColumns`), where it had scrolled sideways under the detail.
 *
 * The kit's, as TableView reads it; an App's split (SplitListDetail.tsx)
 * provides it around the list it holds beside a record.
 */
import { createContext } from 'react';

export const BesideDetail = createContext(false);
