/**
 * A place in the kit an App's component may draw into: a value renderer in
 * a cell, an input in a form's field. The kit never waits for one and never
 * loads one itself. Until the module has arrived — fetched by the shell
 * (shellMode.ts `components`), the first draw that names it having asked —
 * the platform's own `fallback` stands in its place; then every slot showing
 * it redraws once. One that cannot load, or throws, is the fallback from then
 * on, said once in the console.
 *
 * Two of these were written out once each (the value renderers and the
 * inputs), the same cache, listeners and error boundary twice; this is the
 * one. Internal: an author meets the slots only as `ValueProps` and
 * `InputProps` (packages/mistri/schema/ui.d.ts).
 */
import { Component, createElement, useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { shell } from '../shellMode.js';

interface SlotOptions {
  /** The element the component is drawn inside, by class: `custom-value`, `custom-input`. */
  className: string;
  /** Fetch the component `id`; an input names the platform's own with a prefix, and fetches those its own way. */
  load: (id: string) => Promise<unknown>;
  /** Tell the console one cannot be loaded, and that one threw: once each, by the slot's own words. */
  couldNotLoad: (id: string, error: unknown) => void;
  threw: (id: string, error: unknown) => void;
}

/** A kind of slot: its cache of components by build, and the element that draws one. */
export function componentSlot<P extends object>({ className, load, couldNotLoad, threw }: SlotOptions) {
  const drawn = new Map<string, ComponentType<P> | null>();
  const asked = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;

  /* Keyed by the build (the shell's `useKey`): a save that changed the component is asked for again. */
  function settle(key: string, component: ComponentType<P> | null): void {
    drawn.set(key, component);
    version += 1;
    for (const listener of listeners) listener();
  }

  function ask(id: string, key: string): void {
    if (asked.has(key)) return;
    asked.add(key);
    void load(id).then(
      (component) => settle(key, component as ComponentType<P>),
      (error: unknown) => {
        couldNotLoad(id, error);
        settle(key, null);
      },
    );
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const current = () => version;

  class Contained extends Component<{ id: string; slot: string; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error: unknown) {
      /* Once per component: a column of a thousand cells is one mistake, not a thousand. */
      if (drawn.get(this.props.slot) === null) return;
      threw(this.props.id, error);
      settle(this.props.slot, null);
    }
    render() {
      return this.state.failed ? this.props.fallback : this.props.children;
    }
  }

  /** The component `id`, drawn with `props` once it is here, and `fallback` until then (or for good, if it cannot be). */
  function Slot({ id, fallback, props }: { id: string; fallback: ReactNode; props: P }) {
    useSyncExternalStore(subscribe, current, current);
    const key = shell().components.useKey(id);
    useEffect(() => {
      ask(id, key);
    }, [id, key]);
    const component = drawn.get(key);
    if (!component) return <>{fallback}</>;
    return (
      <Contained id={id} slot={key} fallback={fallback}>
        <span className={className} data-component={id}>
          {createElement(component, props)}
        </span>
      </Contained>
    );
  }
  return Slot;
}
