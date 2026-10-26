/** Navigation is supplied by the mounted app shell so reusable list content
 * does not need to reach into the walk's routing implementation. */
import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';

interface ListNavigationLink {
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

type ListNavigation = (view: string, mode?: 'push' | 'reset') => ListNavigationLink | undefined;

const ListNavigationContext = createContext<ListNavigation | undefined>(undefined);

let configuredNavigation: ListNavigation | undefined;

/** The client shell supplies routing once; isolated hosts can pass it directly. */
export function setListNavigation(navigate: ListNavigation): void {
  configuredNavigation = navigate;
}

export function ListNavigationProvider({ navigate, children }: { navigate?: ListNavigation; children: ReactNode }) {
  return <ListNavigationContext.Provider value={navigate ?? configuredNavigation}>{children}</ListNavigationContext.Provider>;
}

export const useListNavigation = (): ListNavigation | undefined => useContext(ListNavigationContext);
