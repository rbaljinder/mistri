/**
 * What the SDK needs from the page's own navigation, handed in by the
 * modules that own it rather than imported from them: the App the reader is
 * in (the shell's answer, shellMode.ts), a record opened as a glance or a dialog (peekpanel.js) and
 * a view followed (viewLink.ts).
 *
 * Those modules sit in the page's one large tangle of imports (a page draws
 * a record, which draws a page), and the SDK is reached from inside it — a
 * value renderer from `Value`, a custom section from `PageSections`. Were the
 * SDK to import them, it would join the tangle (test/repo/runtime-cycles).
 * So it imports nothing of the page's navigation; each owner registers here
 * when it loads, as peekpanel.js already registers its peeker with core.js.
 */
import { shell } from './shellMode.js';

type OpenPeek = (tableId: string, key: Record<string, unknown>, label: string, mode?: 'drawer' | 'modal') => void;

type CommandOutcome =
  | { status: 'applied'; message?: string; output?: unknown }
  | { status: 'refused'; message: string }
  | { status: 'closed' };

/** What sdk/commands.tsx hands the SDK's host: a command as a component holds it, and a form over the page. */
interface CommandHost {
  /* UiCommandHandle (sdk/context.ts), said without importing the React half. */
  command: (
    ref: string,
    page?: string,
  ) => {
    label: string;
    granted: boolean;
    available(key: Readonly<Record<string, unknown>>): Promise<boolean>;
    run(
      key: Readonly<Record<string, unknown>>,
      input?: Readonly<Record<string, unknown>>,
      options?: { label?: string; challenge?: string },
    ): Promise<CommandOutcome>;
    open(
      key: Readonly<Record<string, unknown>>,
      input?: Readonly<Record<string, unknown>>,
      options?: { label?: string },
    ): Promise<CommandOutcome>;
    choices?(field: string): ReadonlyArray<{ value: string | number | boolean; label: string }> | undefined;
  };
  openForm: (view: string, prefill: Readonly<Record<string, string | number>>) => void;
}

interface Bridge {
  activeApp: () => unknown;
  inAppMode: () => boolean;
  openPeek?: OpenPeek;
  openView?: (key: string, options?: { tab?: string; search?: string; filters?: Readonly<Record<string, string>> }) => boolean;
  commands?: CommandHost;
}

/* The App the page is showing, and whether it is showing it, are the shell's answers (shellMode.ts). */
const bridge: Bridge = { activeApp: () => shell().app(), inAppMode: () => shell().inApp() };

/** peekpanel.js: a record opened beside the page, or over it. */
export function registerPeek(openPeek: OpenPeek): void {
  bridge.openPeek = openPeek;
}
/** viewLink.ts: one of the App's lists or dashboards followed. */
export function registerViewOpener(openView: NonNullable<Bridge['openView']>): void {
  bridge.openView = openView;
}
/* sdk/commands.tsx: a component's commands run through the page's own command pipeline and form. It
   draws the command form, whose fields may be components too, so the SDK's host may not import it. */
export function registerCommandHost(host: CommandHost): void {
  bridge.commands = host;
}

export const pageBridge: Readonly<Bridge> = bridge;
