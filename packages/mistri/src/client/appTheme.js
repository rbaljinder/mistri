/**
 * An App's colours on the page: its look, its accent, its face.
 *
 * Apart from appnav.js, which holds the App itself, because the pages drawn
 * before any App is loaded wear it too — the sign-in screen, a landing, a
 * public form are dressed from the look their answer carries — and those
 * pages load without the shell (boot.js says why). The active App, the
 * default dress, is appnav's to answer: it registers itself here.
 */
import {
  configureVisualThemes,
  customThemePartTokens,
  customThemeTokens,
  VISUAL_THEME_EVENT,
  visualThemeChoice,
  visualThemeOverrides,
  visualThemePalette,
  visualThemeScheme,
} from '@mistriwork/kit/client/visualTheme.js';
import { effectiveThemePalette } from '@mistriwork/engine/shared/themePresets.js';
import { fieldEdge, heatTop } from '@mistriwork/engine/shared/themeColor.js';
import { setThemeScheme } from '@mistriwork/kit/client/theme.js';
import { sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { setDensityDefault } from '@mistriwork/kit/client/density.js';
import { addHostListener, setTabTitle, shellBody, shellById, shellQuery, shellRoot } from '@mistriwork/kit/client/shellHost.js';

/** @typedef {import('../shared/app.js').AppTheme & { branding?: import('../shared/branding.js').ResolvedBranding, readerPicker?: boolean }} RecordTheme */
/** @typedef {{ id?: string, name?: string, ui: Pick<import('../shared/app.js').AppUi, 'customThemes'> & { theme?: RecordTheme }, writableTables?: import('../shared/appPayload.js').AppPayloadApp['writableTables'] }} Presentation */
/** @type {Presentation | null} */
let staticApp = null;
let presentationGeneration = 0;
/** @type {WeakMap<object, { generation: number, identity: ReturnType<typeof sessionIdentity> }>} */
const brandingOwners = new WeakMap();

/** Retire request-owned colors before the surface changes. Static authored
 * defaults and Workbench's independent preference store remain available. */
export function retireAppTheme(dressed = staticApp, on = themedOn) {
  ++presentationGeneration;
  headConsumed = true;
  shellById('mistri-branding')?.remove();
  shellById('mistri-branding-style')?.remove();
  if (shellRoot().hasAttribute('data-record-branding')) {
    shellRoot().style.removeProperty('--startup-ground');
    shellRoot().style.removeProperty('--startup-ink');
    try {
      sessionStorage.removeItem('mistri.startup.v1');
    } catch {
      /* Storage is optional. */
    }
  }
  if (dressed && !dressed.ui.theme?.branding) staticApp = dressed;
  themedApp = staticApp;
  if (on) {
    const name = staticApp?.name ?? staticApp?.id ?? 'mistri';
    const brand = shellQuery('.brand-name');
    if (brand) brand.textContent = name;
    setTabTitle(name);
  }
  applyAppTheme(on, staticApp);
}

/** @type {() => (Presentation | null)} */
let source = () => null;

/**
 * A theme the page this shell is embedded in dresses it in (@mistriwork/mistri/react's
 * `theme`, a host's own `defineTheme(...)`), compiled: the App's look while it
 * is set, beside the App's own themes, as an App's own `ui.theme` would be. A
 * record's branding still wins, as it wins over the App's. Never set when
 * served. @type {import('@mistriwork/engine/shared/theme.js').ThemeDefinition | undefined}
 */
let hostTheme;

/** Dress the App in the host's theme (undefined: its own again), and wear it now. @param {typeof hostTheme} theme */
export function setHostTheme(theme) {
  hostTheme = theme;
  applyAppTheme(themedOn, themedOn ? (themedApp ?? source()) : source());
}

/**
 * Where the menu stands while the theme bench dresses the App (server/themeBench): the place the theme posted
 * suggests, where the App says none itself — the bench works that out, as the server does for the App's own
 * theme (shared/appUi.ts placementIn). Undefined: the App's own. @type {'side' | 'top' | undefined}
 */
let hostPlacement;
/** @type {(() => void) | undefined} */
let placementMoved;

/** Stand the menu where the bench says (undefined: where the App puts it), and draw the shell again if it moved. @param {typeof hostPlacement} placement */
export function setHostPlacement(placement) {
  if (placement === hostPlacement) return;
  hostPlacement = placement;
  placementMoved?.();
}

/** Who draws the shell again when the bench moves the menu: the shell (app.js). @param {() => void} listener */
export function whenHostPlacementMoves(listener) {
  placementMoved = listener;
}

/**
 * Where the App's menu stands: the bench's word while it dresses the App, else the App's `ui.shell.placement`.
 * @param {{ ui: { shell?: { placement?: unknown } } } | null | undefined} app
 */
export function shellPlacement(app) {
  return hostPlacement ?? app?.ui.shell?.placement;
}

/** Where the default dress comes from: the active App, once the shell has one. @param {typeof source} answer */
export function setAppThemeSource(answer) {
  source = answer;
}

/**
 * The app's colours, on while the app is curating and off in the workbench.
 *
 * Overrides land as custom properties on `body` — the tokens the whole
 * stylesheet already reads — and are removed rather than reset, so the
 * Workbench keeps its own reader-selected look or native default. Reader-selected
 * presets compose here too, without changing the authored manifest. One colour is a complete theme:
 * the soft tint derives from the accent when the manifest gives only one.
 * `setProperty` is the safety here as much as the mechanism: it takes a
 * single CSS value or nothing, so a manifest cannot smuggle a stylesheet
 * in through a colour.
 */
/**
 * @param {boolean} on
 * @param {Presentation | null} [dressed]
 *   The app whose dress to wear; the active one by default. A public
 *   form has no active app — nothing was fetched signed out but the
 *   form and the App's name and theme — and passes what it was given.
 */
export function applyAppTheme(on, dressed = source()) {
  if (on && !dressed) dressed = staticApp;
  const requested = dressed?.ui.theme?.branding;
  if (requested) {
    const owner = sessionIdentity(),
      held = brandingOwners.get(requested);
    if (
      (held && (held.generation !== presentationGeneration || held.identity !== owner)) ||
      owner.mode === 'locked' ||
      (owner.tenantRequired && (!owner.tenant || requested.identity.tenant !== owner.tenant.tenantId))
    ) {
      dressed = staticApp;
    } else brandingOwners.set(requested, { generation: presentationGeneration, identity: owner });
  } else if (on && dressed) staticApp = dressed;
  themedApp = on ? dressed : null;
  /** @type {(import('../shared/app.js').AppTheme & { branding?: import('../shared/branding.js').ResolvedBranding, readerPicker?: boolean }) | undefined} */
  const suppliedTheme = dressed?.ui.theme;
  let branding = on ? suppliedTheme?.branding : undefined;
  let picker = suppliedTheme?.readerPicker === true;
  // Public boot/sign-in adapters carry static metadata before /api/app. Only
  // this page's public head may bridge that interval; private heads never do.
  if (on && !branding && !headConsumed) {
    try {
      const head = JSON.parse(shellById('mistri-branding')?.textContent || 'null');
      if (head && !head.private && head.value.identity.app === dressed?.id) {
        branding = head.value;
        picker = head.readerPicker === true;
      }
    } catch {
      /* No request presentation. */
    }
  }
  if (suppliedTheme?.branding || !on) headConsumed = true;
  if (branding && dressed)
    dressed = { ...dressed, ui: { ...dressed.ui, theme: { preset: branding.theme.id }, customThemes: [branding.theme] } };
  else if (hostTheme && on && dressed) {
    const own = (dressed.ui.customThemes ?? []).filter((theme) => theme.id !== hostTheme?.id);
    dressed = { ...dressed, ui: { ...dressed.ui, theme: { preset: hostTheme.id }, customThemes: [...own, hostTheme] } };
  }
  shellRoot().toggleAttribute('data-record-branding', Boolean(branding));
  shellById('mistri-branding-style')?.remove();
  const style = shellBody().style;
  configureVisualThemes(
    dressed?.ui.customThemes,
    on ? dressed?.ui.theme?.preset : undefined,
    on,
    on ? dressed?.ui.theme?.palette : undefined,
    branding ? JSON.stringify(['branding', branding.identity.deployment, dressed?.id, branding.identity.tenant]) : dressed?.id,
    /* A signed-out visitor's look (ui.theme.for.public, appLook) is the public's, the same page for everyone: a pick
       made once in the shell does not move it. */
    { locked: Boolean(branding && !picker) || (!branding && suppliedTheme?.audience === 'public'), isolated: Boolean(branding) },
  );
  watchTheme(on);
  /* A theme that says it is dark is worn dark until the reader picks a mode (theme.js); the Workbench has no such theme. */
  setThemeScheme(on ? visualThemeScheme() : undefined);
  /* A part's colors resolve where they are declared, so they are written on body, under the App's own accent: a part
     in `accent` is the App's (visualTheme.ts customThemePartTokens). None outside an App or for a theme without parts. */
  const parts = customThemePartTokens();
  for (const key of partTokenKeys) if (!(key in parts)) style.removeProperty(key);
  for (const [key, value] of Object.entries(parts)) style.setProperty(key, value);
  partTokenKeys = Object.keys(parts);
  /* App-authored overrides never dress Workbench. Its native default takes
     all look tokens back; an explicit pick continues through the same writer. */
  if (!on) {
    shellBody().classList.remove('app-readonly');
    for (const key of ['--accent', '--accent-ink', '--on-accent', '--focus', '--link', '--accent-soft', '--radius', '--chart-1'])
      style.removeProperty(key);
    if (visualThemeChoice() === 'default') {
      const root = shellRoot().style;
      for (const key of customTokenKeys) root.removeProperty(key);
      customTokenKeys = [];
      root.removeProperty('--mono');
      setDensityDefault(undefined);
      return;
    }
  }
  /* An App wears a look — Mono unless the reader or the App picks
     another — and its own authored accent, radius and face win over the
     look's: a brand colour is the App's to keep. */
  const own = on ? (dressed?.ui.theme ?? {}) : {};
  const look = visualThemeOverrides();
  /* One accent is authored for the light ground. On the dark one it is
     mixed toward white, because a mid-blue that reads at 5:1 on off-white
     reads at 3:1 on near-black, and the pressed window pill and the
     current nav item are text. Links follow the accent too: a blue app
     with mistri's teal links looked like two products on one page. */
  const dark =
    shellRoot().dataset.theme === 'dark' || (!shellRoot().dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  /* A read-only app hides the padlock: there is nothing it would open. */
  shellBody().classList.toggle('app-readonly', on && dressed?.writableTables === false);
  /* Mono is square, an authored radius included (docs/design.md, Shape):
     Compass's 8px rounded its window switch, pickers and search box beside
     Mono's square fields and stat cards on one screen. A theme built on Mono
     that names its own radius is that theme's radius, and keeps it. */
  const radius = (look.square ? undefined : own.radius) ?? look.radius;
  if (on) {
    const palette = effectiveThemePalette(visualThemePalette(dark), dark, own);
    style.setProperty('--accent', palette.accent);
    /* Written beside the accent, on body: the root's defaults follow the root's accent, not this one. */
    style.setProperty('--accent-ink', palette.accentInk ?? palette.accent);
    style.setProperty('--on-accent', palette.onAccent ?? 'var(--ground)');
    style.setProperty('--focus', palette.focus);
    style.setProperty('--link', palette.link);
    /* An authored accent is the charts' first series as well; without one the look's palette stands. */
    if (own.accent && palette.chart1) style.setProperty('--chart-1', palette.chart1);
    else style.removeProperty('--chart-1');
    style.setProperty('--accent-soft', palette.accentSoft);
    /* A form's primary action (colors.primary): the theme's, with the words that read on it; else the accent (formDress.css). */
    if (palette.primary) {
      style.setProperty('--primary', palette.primary);
      style.setProperty('--on-primary', palette.onPrimary ?? 'var(--ground)');
    } else {
      style.removeProperty('--primary');
      style.removeProperty('--on-primary');
    }
    if (radius) style.setProperty('--radius', radius);
    else style.removeProperty('--radius');
  }
  /* The data face lands on the *root*, not on body: the reader's own
     typography choice is a class on body whose --mono then wins for
     everything under it — so the look's face is the default and the
     person's preference beats it, with no ordering to get wrong. */
  const root = shellRoot().style;
  const tokens = customThemeTokens(dark);
  /* A matrix's heat stops where its ink would fade on the accent's tint, measured on the accent, panel and ink worn
     (theme.ts heatTop): an App's own accent, or a look the Workbench's reader picked. */
  const worn = effectiveThemePalette(visualThemePalette(dark), dark, own);
  tokens['--heat-top'] = `${Math.round(heatTop(worn) * 100)}%`;
  /* A command form's field edge at rest (formDress.css): the look's control edge where it reads quietly, else that
     edge lightened to the least that clears 3:1 (themeColor.ts fieldEdge), so Mono's ink is not a box round each answer. */
  const edge = fieldEdge(worn);
  if (edge) tokens['--field-edge'] = edge;
  if (!on && radius) tokens['--radius'] = radius;
  for (const key of customTokenKeys) if (!(key in tokens)) root.removeProperty(key);
  for (const [key, value] of Object.entries(tokens)) root.setProperty(key, value);
  customTokenKeys = Object.keys(tokens);
  /* Only a theme that names the current entry's colours turns the rule that draws them on (structure.css). */
  shellRoot().toggleAttribute('data-nav-current', '--nav-current' in tokens);
  /* The same for a pill's corner and a control's edge: a theme that says neither leaves every sheet's own. */
  shellRoot().toggleAttribute('data-pill-radius', '--pill-radius' in tokens);
  shellRoot().toggleAttribute('data-control-radius', '--control-radius' in tokens);
  shellRoot().toggleAttribute('data-rules-control', '--control-border-w' in tokens);
  /* A theme that names a field's colour keeps it, edge and all, where a form would otherwise draw its own well (the
     intake style, MultiStepForm.css). */
  shellRoot().toggleAttribute('data-field-fill', '--field-fill' in tokens);
  /* Both selected looks use their data face. Native Workbench returns above,
     leaving style.css's code face; explicit typography on body still wins. */
  root.setProperty('--mono', own.font ?? look.font);
  /* A theme may say how roomy it starts; the reader's own pick still wins (density.js). */
  setDensityDefault(on ? look.density : undefined);
}

/** @type {string[]} */
let customTokenKeys = [];
/** @type {string[]} */
let partTokenKeys = [];
let headConsumed = false;

/* The derived accent depends on the theme in force, so it is re-derived when
   the OS preference flips or the reader stamps a choice. Attached once, and
   it remembers which mode it was last applied for. */
let themeWatched = false;
let themedOn = false;
/** @type {Parameters<typeof applyAppTheme>[1]} */
let themedApp = null;
function watchTheme(on) {
  themedOn = on;
  if (themeWatched) return;
  themeWatched = true;
  const again = () => applyAppTheme(themedOn, themedOn ? (themedApp ?? source()) : source());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', again);
  addHostListener(window, VISUAL_THEME_EVENT, again);
  new MutationObserver(again).observe(shellRoot(), { attributes: true, attributeFilter: ['data-theme'] });
}
