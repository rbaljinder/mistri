/**
 * Free-form page key passed down into `FilterRail` and `SuggestBox` so every facet count, auto-shape probe, and
 * make/model suggestion attaches `x-mistri-page` when mounted inside a `definePage` (`<ListFilters>`).
 */
import { createContext } from 'react';

export const FilterPageContext = createContext<string | undefined>(undefined);
