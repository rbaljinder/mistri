/**
 * The seam a control kit plugs into (UiKit.tsx): every slotted primitive reads this one context and draws the kit's
 * component for its slot when there is one, its own otherwise, with the same props. The context's default value is
 * the installed kit, so a page that installs one before its first render needs no provider anywhere: nothing
 * re-renders, because nothing changes after paint (a control that swapped once drawn would shift the page).
 */
import { createContext, createElement, useContext, useRef, type ComponentType } from 'react';
import { changeSource, keptDetails } from '../changeDetails.js';

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

/** A slot's change callbacks, by prop: where in the call their details go, and the word to fill in when a kit leaves
    them out. */
type ChangeFills = Readonly<Record<string, readonly [at: number, reason: string]>>;

/* The wrapper is the whole cost of the seam on a page without a kit: one context read and one element. React 19
   carries `ref` as a prop, so a handle (Modal's) and a forwarded element ref (Button's) pass through untouched. */
export function slotted<C extends AnyComponent>(name: string, Default: C, fills?: ChangeFills): C {
  defaultSlots[name] = Default;
  return ((props: Record<string, unknown>) => {
    const Kit = useContext(UiKitContext)[name];
    // The kit's change callbacks keep one identity for the life of the control, and read the caller's latest on each call.
    const latest = useRef(props);
    latest.current = props;
    const wrappers = useRef<Record<string, (...args: unknown[]) => unknown>>({});
    return createElement(Kit ?? Default, Kit && fills ? filled(props, fills, latest, wrappers.current) : props);
  }) as unknown as C;
}

/* A kit may call a change callback with the value alone, or with details of its own that name no hand (Base UI's); every
   caller reads `{ reason, source }` second, so the seam fills in what is missing. Only under a kit: the defaults always
   give them. A wrapper's identity is stable, so a kit that puts the callback in an effect's dependencies does not rerun it
   on every render. */
function filled(
  props: Record<string, unknown>,
  fills: ChangeFills,
  latest: { current: Record<string, unknown> },
  wrappers: Record<string, (...args: unknown[]) => unknown>,
): Record<string, unknown> {
  let out = props;
  for (const [key, [at, reason]] of Object.entries(fills)) {
    if (typeof props[key] !== 'function') continue;
    if (out === props) out = { ...props };
    out[key] = wrappers[key] ??= (...args: unknown[]) => {
      const callback = latest.current[key];
      if (typeof callback !== 'function') return undefined;
      args[at] = withSource(args[at], reason);
      return callback(...args);
    };
  }
  return out;
}

/* Details as the kit gave them, a hand and a word added where they lack one. A raw `none` is Base UI's, and no caller
   hears it. Filled in place where it can be: Base UI's details carry `cancel()` and an `isCanceled` that must stay live. */
function withSource(given: unknown, reason: string): unknown {
  const kept = keptDetails(reason);
  if (typeof given !== 'object' || given === null) return kept;
  const details = given as { reason?: unknown; source?: unknown; event?: unknown };
  if (details.source !== undefined) return given;
  const word = typeof details.reason === 'string' && details.reason !== 'none' ? details.reason : reason;
  // Base UI's stand-in event, named `base-ui`, says the page made the change (changeDetails.ts).
  const source =
    details.event instanceof Event ? (details.event.type === 'base-ui' ? 'program' : changeSource(details.event)) : kept.source;
  if (!Object.isExtensible(given)) return { ...details, reason: word, source };
  Object.assign(details, { reason: word, source });
  return given;
}
