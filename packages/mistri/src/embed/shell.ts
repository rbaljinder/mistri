/**
 * The shell in a host's page: the part of `@mistriwork/mistri/react` that is loaded
 * only when a mistri element first renders in a browser, and that carries
 * the client itself (its own chunk, so a host's first page does not pay for
 * it until the route that shows mistri does).
 *
 * The shell is the served client's, module singletons and all (core.js
 * `state`), so a document holds one: one App, drawn either whole under the
 * host's router (`<App>`) or as one surface on an address of its
 * own in memory (`<List>`, `<Record>`, …). The first
 * element to attach boots it; unmounting parks it — its frame is detached and
 * kept, its navigations unheard — and the next element re-attaches it and
 * the shell reads the address again. React's StrictMode double effect is a
 * park and a re-attach, and costs nothing.
 */
/* First of all, so the shell's every rule comes after it (embedReset.css says why). */
import './embedReset.css';
import { skeleton } from 'virtual:mistri-skeleton';
/* After the shell's own sheets (the skeleton module imports them), so its rules come last in `mistri`. */
import './embed.css';
import { bind, binding, isBound, pauseNavigation, rebindNavigator, resumeNavigation, announceNavigation } from './binding.js';
import { holdStyles } from './styles.js';
import { currentEntry } from '@mistriwork/kit/client/core.js';
import type { Navigator } from './navigator.js';
import type { AddressMount } from '@mistriwork/engine/shared/mount.js';
import { FIRST_PAINT_ELEMENT, type FirstPaintData } from '@mistriwork/engine/shared/firstPaint.js';

export interface Attachment {
  /** The element the shell's root is put in: the component's own slot. */
  slot: HTMLElement;
  app: string;
  /** `app`: the whole App, chrome and all, at the host's address. A surface: one room, no chrome. */
  surface: 'app' | 'list' | 'record' | 'dashboard' | 'page' | 'assistant';
  navigator: Navigator;
  address: AddressMount;
  endpoint: string;
  authorization(): string | undefined;
  title(text: string): void;
  /** Applied once the shell has drawn. `theme` is a look's id, or a host's own `defineTheme(...)` value. */
  preferences: { mode?: 'light' | 'dark' | 'system'; density?: 'compact' | 'comfortable' | 'spacious'; theme?: string | object };
  /** The boot's first answers (server/embed/boot.ts), for the shell's first requests; read only by the attachment that boots it. */
  firstPaint?: FirstPaintData;
}

interface Shell {
  app: string;
  frame: HTMLElement;
  root: HTMLElement;
  body: HTMLElement;
  started: Promise<void>;
  attached: Attachment | null;
}

let shell: Shell | null = null;

/** Why this attachment cannot have the shell, or undefined. */
function refusal(next: Attachment): string | undefined {
  if (!shell) return undefined;
  if (shell.app !== next.app)
    return `@mistriwork/mistri/react draws one App per page, and "${shell.app}" is already on this one; "${next.app}" cannot join it until the first one is gone.`;
  if (shell.attached && shell.attached.slot !== next.slot)
    return `@mistriwork/mistri/react draws one mistri element at a time on a page (the App, or one surface of it), and another is already showing.`;
  return undefined;
}

/**
 * The skeleton's content pane is the served page's one <main>. In a host's
 * page the host has its own, usually around the slot, and a document has one
 * main landmark: the pane becomes a plain element there, the same id, class
 * and children, so everything that finds it by `#content` still does.
 */
function ownNoLandmark(body: HTMLElement): void {
  const main = body.querySelector('main');
  if (!main) return;
  const pane = document.createElement('div');
  for (const { name, value } of main.attributes) pane.setAttribute(name, value);
  pane.append(...main.childNodes);
  main.replaceWith(pane);
}

function makeRoot(): { frame: HTMLElement; root: HTMLElement; body: HTMLElement; portals: HTMLElement } {
  /* The window, the root's <html> and its <body>; embedReset.css says why the frame. */
  const frame = document.createElement('div');
  frame.className = 'tw-frame';
  const root = document.createElement('div');
  root.className = 'tw-root';
  root.setAttribute('data-mistri', '');
  root.setAttribute('data-starting', '');
  const body = document.createElement('div');
  body.className = 'tw-body';
  body.innerHTML = skeleton;
  ownNoLandmark(body);
  const portals = document.createElement('div');
  portals.className = 'tw-portals';
  body.append(portals);
  root.append(body);
  frame.append(root);
  return { frame, root, body, portals };
}

/**
 * The shell's height is the slot's, not the window's: `--shell-vh` (density.js)
 * is the body's height token, set here to the slot's height in the zoomed
 * root's own pixels. A slot the host left without a height keeps the window's.
 */
function followSlot(slot: HTMLElement, root: HTMLElement, body: HTMLElement): () => void {
  const measure = () => {
    const height = slot.getBoundingClientRect().height;
    const zoom = Number.parseFloat(getComputedStyle(root).zoom) || 1;
    if (height > 0) body.style.setProperty('--shell-vh', `${height / zoom}px`);
    else body.style.removeProperty('--shell-vh');
  };
  measure();
  const sized = new ResizeObserver(measure);
  sized.observe(slot);
  /* density.js writes the zoom on the root's style. */
  const zoomed = new MutationObserver(measure);
  zoomed.observe(root, { attributes: true, attributeFilter: ['style'] });
  return () => {
    sized.disconnect();
    zoomed.disconnect();
  };
}

async function applyPreferences(preferences: Attachment['preferences']): Promise<void> {
  if (preferences.mode) (await import('@mistriwork/kit/client/theme.js')).setTheme(preferences.mode);
  if (preferences.density) (await import('@mistriwork/kit/client/density.js')).setDensityDefault(preferences.density);
  if (typeof preferences.theme === 'object' && preferences.theme) {
    /* A host's own theme, checked and compiled as an App's `defineTheme` is (an invalid one throws a sentence naming the field), then worn as the App's look. */
    const [{ compileAppTheme }, { setHostTheme }, { setVisualTheme }] = await Promise.all([
      import('../shared/themeSpec.js'),
      import('../client/appTheme.js'),
      import('@mistriwork/kit/client/visualTheme.js'),
    ]);
    const theme = compileAppTheme(preferences.theme, '@mistriwork/mistri/react theme');
    setHostTheme(theme);
    setVisualTheme(theme.id);
  } else if (preferences.theme) (await import('@mistriwork/kit/client/visualTheme.js')).setVisualTheme(preferences.theme);
}

/**
 * The boot's answers, where the served page carries them: a data block in the
 * shell (client/firstPaint.ts reads it by id, inside the shell's root, the
 * first time a request is made, and removes it).
 */
function carry(body: HTMLElement, data: FirstPaintData | undefined): void {
  if (!data) return;
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = FIRST_PAINT_ELEMENT;
  block.textContent = JSON.stringify(data);
  body.append(block);
}

async function boot(): Promise<void> {
  /* The App framework's main, fetched beside the rest: an embedded App is never the Workbench, and its host's page carries no meta to say so. */
  const main = import('../client/appShell.js');
  const [{ startShell }, { failStartup, finishStartup }, { startupSettled }, { lookSheetReady }] = await Promise.all([
    import('@mistriwork/kit/client/shellStart.js'),
    import('@mistriwork/kit/client/startup.js'),
    import('@mistriwork/kit/client/startupHold.js'),
    import('@mistriwork/kit/client/visualTheme.js'),
  ]);
  /* boot.js's sequence: the look, who is here, the App, then the veil comes off once the room is complete. */
  await startShell(main)
    .then(lookSheetReady)
    .then(() => startupSettled())
    .then(finishStartup)
    .catch(failStartup);
}

/**
 * Put the shell in `next.slot`, booting it the first time. Throws a sentence
 * when another App, or another element, already has it. Returns the park.
 */
export function attachShell(next: Attachment): () => void {
  const refused = refusal(next);
  if (refused) throw new Error(refused);
  const releaseStyles = holdStyles();
  if (!shell) {
    const { frame, root, body, portals } = makeRoot();
    bind({
      root,
      body,
      portals,
      navigator: next.navigator,
      address: next.address,
      endpoint: next.endpoint,
      authorization: next.authorization,
      title: next.title,
    });
    carry(body, next.firstPaint);
    shell = { app: next.app, frame, root, body, started: Promise.resolve(), attached: null };
    shell.started = boot().then(() =>
      applyPreferences(next.preferences).catch((error: unknown) =>
        console.error(`@mistriwork/mistri/react: ${error instanceof Error ? error.message : String(error)}`),
      ),
    );
  } else {
    const bound = binding();
    bound.address = next.address;
    bound.endpoint = next.endpoint;
    bound.authorization = next.authorization;
    bound.title = next.title;
    rebindNavigator(next.navigator);
    resumeNavigation();
    /* Re-attached: wherever the address went while it was parked, the shell goes too. */
    void shell.started.then(() => {
      if (shell?.attached === next) announceNavigation();
    });
  }
  const current = shell;
  current.attached = next;
  if (next.surface === 'app') current.root.removeAttribute('data-surface');
  else current.root.setAttribute('data-surface', next.surface);
  next.slot.append(current.frame);
  const unfollow = followSlot(next.slot, current.root, current.body);
  let parked = false;
  return () => {
    if (parked) return;
    parked = true;
    unfollow();
    if (current.attached === next) {
      current.attached = null;
      current.frame.remove();
      if (isBound()) pauseNavigation();
    }
    releaseStyles();
  };
}

/** The record the shell is opening, if it is opening one: a row, or a record's page (an App's record opens as one). */
export function openingRecord(): { resource: string; key: Record<string, unknown> } | null {
  const entry = currentEntry() as { table?: unknown; key?: unknown } | undefined;
  if (typeof entry?.table !== 'string' || !entry.key || typeof entry.key !== 'object') return null;
  return { resource: entry.table, key: entry.key as Record<string, unknown> };
}
