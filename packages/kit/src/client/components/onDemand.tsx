/**
 * The parts of the client that load the first time they are used.
 *
 * The published client is split (vite.config.ts): the Workbench's tools,
 * the builders, boards, charts and the tenancy dialogs are chunks of their
 * own, fetched when someone first opens one, so an App's first page does
 * not wait for them. An import site names its part with `onDemand` and
 * draws it like any component; this module is what shows while the chunk
 * is on its way, and what shows when it cannot come.
 *
 * Waiting is quiet. Nothing for the first moments — a cached chunk arrives
 * within a frame, and a placeholder that flashes reads as a glitch — then
 * one still line of text: no spinner, no pulse (docs/design.md, motion
 * rules 1 and 8). A part that is a dialog or a control waits with nothing at
 * all, since there is no place of its own to say anything in. A host that
 * draws a frame of its own — a modal panel, whose focus trap is the part's —
 * awaits `ready()` first, so the frame never stands empty and open to Tab.
 *
 * A chunk that cannot load is almost always a deploy: the page was opened
 * before it, and the file it names is gone. The only cure is the new page,
 * so that is what is offered — a sentence and a Reload button where the
 * part would have been, or the same offer as a toast for a part with no
 * place of its own. Never a blank room. Only the load is caught: an error
 * inside a part that did load goes wherever it went before it was split.
 *
 * Not React.lazy: a lazy component suspends on its first draw even when its
 * module is already here, and a part that has arrived must draw at once.
 *
 * No stylesheet may be imported here or by anything this imports: Node's
 * suites load client modules that use it.
 */
import { createElement, useEffect, useState, type ComponentType } from 'react';
import { toast } from '../core.js';
import { Delayed } from './Skeleton.js';
import { beginWork } from '../pendingWork.js';
import { say } from '../copy/shell/components/onDemand.js';

const reload = () => {
  window.location.reload();
};

function tracked<M>(load: () => Promise<M>): Promise<M> {
  const settled = beginWork();
  return load().finally(settled);
}

function Unavailable() {
  return (
    <p className="note" role="alert">
      {say('couldNotLoad')}{' '}
      <button type="button" className="ghost" onClick={reload}>
        {say('common.reload')}
      </button>
    </p>
  );
}

/** The same offer as a toast, for a part with no place of its own — or a module loaded by hand. */
export function sayUnavailable(): void {
  toast(say('couldNotLoad'), 'error', { label: say('common.reload'), run: reload });
}

function UnavailableQuietly() {
  useEffect(sayUnavailable, []);
  return null;
}

const waiting = (
  <Delayed>
    <p className="loading" role="status">
      {say('common.loading')}
    </p>
  </Delayed>
);

/** The part's own component, plus the way to have it here before it is drawn, and whether it is. */
type OnDemand<C> = C & { ready(): Promise<void>; here(): boolean };

/**
 * The named export of a module the bundler may put in a chunk of its own,
 * as a component that loads it on its first draw. The type is the export's
 * own, so the call sites and their props read as they did with a static
 * import. `quiet` is for dialogs and controls: nothing while waiting, and a
 * toast if the load fails.
 */
export function onDemand<M, K extends keyof M>(load: () => Promise<M>, name: K, { quiet = false } = {}): OnDemand<M[K]> {
  let part: ComponentType<object> | undefined;
  let arriving: Promise<void> | undefined;
  /* Counted while it travels, so a navigation holds for the part as it does for a request (pendingWork.ts). */
  const ready = () =>
    (arriving ??= tracked(load).then(
      (module) => {
        part = module[name] as ComponentType<object>;
      },
      (error: unknown) => {
        console.error(`The ${String(name)} chunk did not load.`, error);
        part = quiet ? UnavailableQuietly : Unavailable;
      },
    ));
  function OnDemandPart(props: object) {
    const [, arrived] = useState(0);
    useEffect(() => {
      if (part) return;
      let drawn = true;
      void ready().then(() => {
        if (drawn) arrived((n) => n + 1);
      });
      return () => {
        drawn = false;
      };
    }, []);
    if (part) return createElement(part, props);
    return quiet ? null : waiting;
  }
  OnDemandPart.displayName = `OnDemand(${String(name)})`;
  OnDemandPart.ready = ready;
  OnDemandPart.here = () => part !== undefined;
  return OnDemandPart as unknown as OnDemand<M[K]>;
}

/**
 * Whether a part is here to draw, fetching it if not. For a host that waits
 * in words of its own rather than the part's: a page section keeps its own
 * skeleton until both its read and its drawing have arrived, so the one
 * placeholder stands throughout, and a grid draws its cells as plain values
 * until their editor has come. A part that could not load is "here" as the
 * part's Reload offer, which the host draws in its place.
 */
export function useArrived(part: { ready(): Promise<void>; here(): boolean }, wanted = true): boolean {
  const [, arrived] = useState(0);
  const here = part.here();
  useEffect(() => {
    if (here || !wanted) return;
    let drawn = true;
    void part.ready().then(() => {
      if (drawn) arrived((n) => n + 1);
    });
    return () => {
      drawn = false;
    };
  }, [part, here, wanted]);
  return here;
}
