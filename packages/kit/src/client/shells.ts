/**
 * The kit's shell API: what a product's main installs into the kit's boot
 * (app.js `boot`), and what the boot hands back.
 *
 * The page's entry (boot.js, shellStart.js) wears the look and then starts
 * one product's main, chosen from the page the server sent: the App
 * framework's (appShell.js) or the database browser's (workbenchShell.js).
 * Each main asks who is here, does what is its own before the shell (an App's
 * public pages, its sign-in, a token's consent), and then calls the kit's
 * boot with its `ShellProduct`:
 *
 *   chrome   the product's chrome around the kit's bar and menu, and its
 *            answers to the kit (shellMode.ts): the App framework's
 *            (appnav.js `appChrome`) or the Workbench's (workbenchShell.js);
 *   tools    the Workbench's tools (workbench.js `workbenchShell`): the query
 *            bar, the SQL pane, the connections, Undo. An App has none.
 *
 * The boot is the kit's — the walk, the content pane, the address, the menu,
 * the palette — and calls the product at the places below, so the kit names
 * neither product and neither product imports the other. What a member is
 * optional for, the kit does without: a part of an App (a tenant, an account,
 * a look named by who-am-I) is simply not there in the Workbench.
 *
 * Types only: a leaf any module may read.
 */
import type { ShellMode } from './shellMode.js';

type Me = Record<string, any>;

/** What the boot hands a product to call back into: its own steps, which a product's flow repeats or waits on. */
export interface KitShell {
  /** Back to the schema, or the App's home, from anywhere (the wordmark, `h`). */
  goHome(): void;
  /** The content pane's "opening a workspace" line, while a tenant's surface is cleared or rebuilt. */
  showWorkspaceOpening(): void;
  /** Clear the business surface, as a tenant switch or a denial does. */
  clearSurface(me: Me): Promise<void>;
  /** Build it again for the context now chosen, as at start. */
  rebuildSurface(me: Me): Promise<void>;
  /** Whether the business surface was retired under the boot (a tenant's access ended). */
  retired(): boolean;
  /** Mark it retired, so the boot stops where it stands. */
  retire(): void;
}

/** A product's chrome around the kit's bar and menu: the App framework's (appnav.js) or the Workbench's (workbenchShell.js). */
export interface ShellChrome {
  /** The product's answers to the kit (shellMode.ts), installed before anything asks. */
  answers?: Partial<ShellMode>;
  /** What the page shows of the product, for the connection now open: an App's payload and pages, or the Workbench's words. */
  loadNav(): Promise<unknown>;
  /** The bar's product parts, each brand pass: an App's mark, the tab's room title, its badge, New menu and assistant. */
  brand(): void;
  /** The product's look, each brand pass: an App's colours (appTheme.js), or the Workbench's own pick. */
  dress(): void;
  /** The menu's shell: the side list, or an App's top bar or phone drawer. True where the kit draws the side list. */
  menu(): boolean;
  /** The query language's reference and the keys, registered where it stands in the menu. */
  initHelp(): void;
  /** What the page says when nothing can be shown: no App by that name here, or why it is not served. */
  unavailable(unknown?: unknown, reason?: string): void;

  /* The App framework's alone: the kit does without each where a product has none. */

  /** Once, as the boot starts: the guards and links that hold for the whole page. */
  start?(me: Me): void;
  /** A tenant session's flows, loaded for one (tenantShell.js). */
  loadTenancy?(me: Me): Promise<boolean>;
  /** The session lifecycle's tenant callbacks (sessionLifecycle.ts), built over the kit's steps. */
  lifecycle?(me: Me, kit: KitShell): Record<string, (owner: any) => unknown>;
  /** Where a page that signed in at the staff door starts instead, or null to keep the address. */
  signedInStart?(me: Me, landingAt: unknown): string | null;
  /** A tenant session's chooser, before the App: the address to start on and its tenant's, or null where boot stops. */
  chooseTenant?(
    me: Me,
    requestedApp: string | null,
    incomingLocation: string,
    kit: KitShell,
  ): Promise<{ incoming: string; tenantIncoming: string } | null>;
  /** Back and Forward in a session that needs a tenant chosen: the tenant's history decides. */
  followHistory?(href: string, handlers: Record<string, unknown>): void;
  /** Wear the App's look named by who-am-I, where no App payload is loaded yet. */
  wearLook?(me: Me, look: Record<string, any> | undefined): void;
  /** The App's payload again after a save: whether the answer was taken. */
  reloadNav?(): Promise<boolean>;
  /** A warm cache of the reader's saved filters, never a gate on the first paint. */
  loadFilters?(): Promise<unknown>;
  /** Take down the App's presentation, leaving its own look where a tenant's surface is cleared. */
  retire?(me: Me): void;
  /** The account at the end of the bar, and the tenant control beside it. */
  showAccount?(me: Me, kit: KitShell): Promise<void>;
  /** Whether the tenant walk is ready, so the account offers its switch. */
  navigationReady?(ready: boolean): void;
  /** The App's settings records, as menu commands (appSettings.ts). */
  settings?(): Array<Record<string, unknown>>;
  /** The width at which an App's side menu becomes a phone's drawer; the menu is drawn again when it is crossed. */
  compactNavigation?: MediaQueryList;
  /** The theme bench moved the menu (themeBench.ts): the kit draws the shell again around the same room. */
  whenMenuMoves?(listener: () => void): unknown;
  /** Follow the App's source on disk, where the server watches it. */
  followSaves?(reload: () => Promise<void>): void;
  /** A tenant's public address that names no workspace, under the App's name, with its sign-in. */
  noWorkspace?(appName: string, signIn: string): void;
}

/** Where in the menu's order the tools register a command: registration is order of appearance (menu.js). */
type ToolsMenuPlace = 'editing' | 'sql' | 'schema' | 'undo' | 'tools';

/** The Workbench's tools (workbench.js): the query bar, the SQL pane, connections, Undo and the database's own commands. */
export interface ShellTools {
  /** Once, before the first paint: their answers, their registrations and their keys. */
  start(kit: KitShell): void;
  /** Each brand pass: the completer where the Workbench shows, and its menu groups. */
  brand(): void;
  /** The per-connection stores they keep: saved pages and committed SQL. */
  loadStores(): Promise<unknown>;
  /** Their commands, each at its place in the menu. */
  menu(at: ToolsMenuPlace): void;
  /** The screen for a server with no connection open: what is listed, and the way to add one (welcome.js). */
  showWelcome(listed: any[]): unknown;
  listConnections(): Promise<any[]>;
}

/** What a product's main installs into the kit's boot (app.js `boot`). */
export interface ShellProduct {
  chrome: ShellChrome;
  /** The Workbench's tools; none in an App. */
  tools?: ShellTools;
}

/** A product's main, as the entry (shellStart.js) loads it with import(): everything past the look before the first paint. */
export interface ShellMain {
  start(): Promise<void>;
}
