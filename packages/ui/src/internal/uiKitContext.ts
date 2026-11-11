/**
 * The seam a control kit plugs into (UiKit.tsx): every slotted primitive reads this one context and draws the kit's
 * component for its slot when there is one, its own otherwise, with the same props. The context's default value is
 * the installed kit, so a page that installs one before its first render needs no provider anywhere: nothing
 * re-renders, because nothing changes after paint (a control that swapped once drawn would shift the page).
 */
import { createContext, createElement, useContext, type ComponentType } from 'react';

type AnyComponent = ComponentType<any>;

const installed: Record<string, AnyComponent | undefined> = {};

/** The primitives' own drawing, by slot, filled as each slotted module loads. */
export const defaultSlots: Record<string, AnyComponent> = {};

export const UiKitContext = createContext<Record<string, AnyComponent | undefined>>(installed);

/** Puts a kit in place for every render that has no provider above it; called once, before the first render. */
export function installUiKit(kit: Record<string, AnyComponent | undefined> | undefined): void {
  for (const name of Object.keys(installed)) delete installed[name];
  Object.assign(installed, kit);
}

/* The wrapper is the whole cost of the seam on a page without a kit: one context read and one element. React 19
   carries `ref` as a prop, so a handle (Modal's) and a forwarded element ref (Button's) pass through untouched. */
export function slotted<C extends AnyComponent>(name: string, Default: C): C {
  defaultSlots[name] = Default;
  return ((props: object) => createElement(useContext(UiKitContext)[name] ?? Default, props)) as unknown as C;
}
