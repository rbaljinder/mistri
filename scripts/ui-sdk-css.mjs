/**
 * UI SDK's own stylesheet as @mistriwork/ui carries it, split along Mistri's first-paint seam from
 * node_modules/@ui-sdk/core/dist/web.css:
 *
 * - `packages/ui/src/styles/ui-sdk.css` holds the rules and selector arms for the core first-paint controls
 *   (`controls.css`).
 * - `packages/ui/src/styles/ui-sdk-surfaces.css` holds the rules and selector arms drawn by the lazy surface bundles
 *   (`packages/ui/src/primitives/` and `packages/ui/src/views/`, loaded into `layer(ui-sdk-lazy)` under `base`).
 *
 * Neither takes UI SDK's sheet whole:
 *
 * - UI SDK's sheet dresses a few bare elements (a link, a rule, a code span). On a page of its own that is the
 *   page's look; here those elements are the kit's and an App's, and a rule for every `a` would dress theirs.
 * - Rules and standalone `[data-slot="..."]` selector arms for parts nothing here draws are omitted, and surface-only
 *   families wait behind `ui-sdk-surfaces.css` so first paint never pays for composite views, editors or pickers it
 *   has not opened. Which families each tier draws is read from what the packages import (`@ui-sdk/react/<family>`),
 *   and `test/ui-sdk-css.test.ts` fails if either generated sheet drifts.
 * - Its own default colours are never read: packages/ui/src/styles/m-tokens.css says each of those names from the
 *   package's tokens. A default left here would be a colour no theme can move, so each name that sheet says is
 *   taken out of UI SDK's.
 *
 *   node scripts/ui-sdk-css.mjs           writes ui-sdk.css and ui-sdk-surfaces.css
 *   node scripts/ui-sdk-css.mjs --check   fails if either file differs from what the installed UI SDK and imports give
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const SOURCE = 'node_modules/@ui-sdk/core/dist/web.css';
const TARGET = 'packages/ui/src/styles/ui-sdk.css';
const SURFACES_TARGET = 'packages/ui/src/styles/ui-sdk-surfaces.css';

/** The selectors of the rules that dress an element by its tag alone. */
const BARE = new Set(['a', ':is(a, summary):focus-visible', 'hr', 'code', 'kbd']);

/** The sheet's one layer block with the bare-element rules taken out; everything else as it was written. */
export function withoutBareElements(css) {
  const open = css.indexOf('{');
  const close = css.lastIndexOf('}');
  const body = css.slice(open + 1, close);
  let kept = '';
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      if (depth === 0)
        prelude = body
          .slice(start, i)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim()
          .replace(/\s+/g, ' ');
      depth++;
    } else if (body[i] === '}') {
      depth--;
      if (depth === 0) {
        if (!BARE.has(prelude)) kept += body.slice(start, i + 1);
        start = i + 1;
      }
    }
  }
  return `${css.slice(0, open + 1)}${kept}${body.slice(start)}${css.slice(close)}`;
}

/** Headless math/state modules in `@ui-sdk/react/*` that draw no `[data-slot]` elements of their own. */
const HEADLESS_MODULES = new Set(['agent', 'async-options', 'color', 'date', 'history', 'preferences', 'shortcuts', 'text-match']);

const LAZY_SURFACE_DIRS = new Set([root('packages/ui/src/primitives'), root('packages/ui/src/views')]);

function collectFamilies(dir, families, skipDir = () => false) {
  if (!existsSync(dir) || skipDir(dir)) return;
  for (const one of readdirSync(dir, { withFileTypes: true })) {
    if (one.name === 'node_modules' || one.name === 'dist') continue;
    const at = `${dir}/${one.name}`;
    if (one.isDirectory()) collectFamilies(at, families, skipDir);
    else if (/\.tsx?$/.test(one.name) && !/\.(test|stories)\./.test(one.name))
      for (const found of readFileSync(at, 'utf8').matchAll(/from '@ui-sdk\/react\/([a-z-]+)'/g))
        if (!HEADLESS_MODULES.has(found[1])) families.add(found[1]);
  }
}

/** Slots drawn over a photo or a colour swatch, whose white must stay light whatever the page's scheme. */
const OVER_IMAGERY = /data-slot="(?:image-cropper-[a-z-]+|color-picker-(?:area|slider)-thumb)"/;

/**
 * UI SDK's white in the rules for parts that sit over imagery, said as the lightbox's ink before the general
 * substitution turns white into `--surface` and `--line`, which are near-black in a dark scheme.
 */
export function lightOverImagery(css) {
  return css.replace(/oklch\(1 0 0(?: \/ 0\.6)?\)/g, (white, at) => {
    const rule = Math.max(css.lastIndexOf('\n  [data-slot=', at), css.lastIndexOf('\n  :is(', at));
    if (rule < 0 || !OVER_IMAGERY.test(css.slice(rule, css.indexOf('{', rule)))) return white;
    return white.includes('/') ? 'color-mix(in srgb, var(--lightbox-ink) 60%, transparent)' : 'var(--lightbox-ink)';
  });
}

/** Replace hardcoded `oklch(...)` literals, unscaled `rem` font sizes, 4px outlines, off-scale radii, and unconstrained popup/segment widths in UI SDK's sheets with Mistri's house tokens. */
export function tokenizeSlotColors(css) {
  /* `calc(var(--ui-radius) * 999)` is UI SDK's word for a part that is round by nature (a switch, its thumb, a scroll
     thumb, a colour slider): said as 999px, so a look whose corners are square or whose pill corner is small does not
     square it. */
  return lightOverImagery(css)
    .replaceAll('oklch(1 0 0 / 0.6)', 'var(--line)')
    .replaceAll('oklch(1 0 0)', 'var(--surface)')
    .replaceAll('oklch(0.145 0 0)', 'var(--ground)')
    .replaceAll('oklch(0 0 0 / 0.5)', 'var(--scrim)')
    .replaceAll('oklch(0 0 0 / 0.4)', 'var(--scrim)')
    .replaceAll('oklch(0 0 0 / 0.1)', 'var(--line)')
    .replaceAll('font-size: calc(var(--ui-font-size) - 0.0625rem);', 'font-size: var(--text-sm);')
    .replaceAll('font-size: calc(var(--ui-font-size) - 0.125rem);', 'font-size: var(--text-xs);')
    .replaceAll('font-size: calc(var(--ui-font-size) + 0.125rem);', 'font-size: var(--text-md);')
    .replaceAll('font-size: max(1rem, var(--ui-font-size));', 'font-size: max(calc(16px * var(--type-k, 1)), var(--text-base));')
    .replaceAll(
      'outline: 4px solid var(--ui-ring);\n    outline-offset: 0;',
      'outline: var(--focus-width, 2px) solid var(--focus, var(--ui-ring-border));\n    outline-offset: var(--focus-offset, 2px);',
    )
    .replaceAll(
      'border-color: var(--ui-ring-border);\n      outline: 4px solid var(--ui-ring);',
      'border-color: var(--focus, var(--ui-ring-border));\n      outline: var(--focus-width, 2px) solid var(--focus, var(--ui-ring-border));\n      outline-offset: -1px;',
    )
    .replaceAll('outline: 4px solid var(--ui-ring);', 'outline: var(--focus-width, 2px) solid var(--focus, var(--ui-ring-border));')
    .replaceAll(
      'outline-color: color-mix(in oklab, var(--ui-destructive) 20%, transparent);',
      'outline-color: var(--focus, var(--ui-ring-border));',
    )
    .replaceAll('border-radius: calc(var(--ui-radius) * 1.5);', 'border-radius: var(--radius-card, var(--ui-radius));')
    .replaceAll(
      'border-radius: max(0px, calc(var(--ui-radius) * 1.5 - var(--ui-spacing)));',
      'border-radius: var(--radius-item, max(0px, calc(var(--ui-radius) - 2px)));',
    )
    .replaceAll('calc(var(--ui-radius) * 999)', '999px')
    .replaceAll('width: calc(2ch + 4px);', 'width: auto;\n      min-width: 2.2ch;')
    .replaceAll('width: calc(4ch + 4px);', 'width: auto;\n      min-width: 4.2ch;')
    .replaceAll('width: calc(2.6ch + 4px);', 'width: auto;\n      min-width: 3ch;')
    .replace(
      ':is(\n    [data-slot="select-content"],\n    [data-slot="autocomplete-content"]\n  ) {\n    min-width: var(--anchor-width);\n  }',
      `:is(\n    [data-slot="select-content"],\n    [data-slot="autocomplete-content"]\n  ) {\n    min-width: var(--anchor-width);\n    max-width: min(24rem, var(--available-width, calc(100vw - 1rem)));\n  }\n\n  [data-slot="select-content"] {\n    width: max(var(--anchor-width, 12rem), min(18rem, var(--available-width, calc(100vw - 1rem))));\n  }\n\n  [data-slot="select-item"] {\n    min-width: 0;\n    overflow: hidden;\n    text-overflow: ellipsis;\n  }\n\n  :is([data-slot="menu-content"], [data-slot="popover-content"]) {\n    max-width: min(26rem, var(--available-width, calc(100vw - 1rem)));\n  }`,
    )
    .replace(
      ':is(\n    [data-slot="combobox-content"]\n  ) {\n    min-width: var(--anchor-width);\n  }',
      `:is(\n    [data-slot="combobox-content"]\n  ) {\n    min-width: var(--anchor-width);\n    max-width: min(26rem, var(--available-width, calc(100vw - 1rem)));\n  }`,
    );
}

/** The UI SDK families drawn on first paint: every `@ui-sdk/react/<family>` outside the lazy `primitives/` and `views/` bundles. */
export function familiesDrawn() {
  const families = new Set();
  for (const pkg of readdirSync(root('packages'))) {
    collectFamilies(root(`packages/${pkg}/src`), families, (dir) => LAZY_SURFACE_DIRS.has(dir));
  }
  return families;
}

/** The UI SDK families drawn exclusively by `@mistriwork/ui`'s lazy `primitives/` and `views/` bundles. */
export function surfacesFamiliesDrawn(coreFamilies = familiesDrawn()) {
  const families = new Set();
  for (const dir of LAZY_SURFACE_DIRS) collectFamilies(dir, families);
  for (const core of coreFamilies) families.delete(core);
  return families;
}

/* Parts a family draws under another's name, and the ones any of them may use. */
const SHARED = ['label', 'visually-hidden', 'separator', 'popup', 'arrow', 'backdrop', 'form-input'];

/** The top-level statements of a CSS block: `[text, prelude]` pairs, in order. */
function statements(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      if (depth === 0) prelude = body.slice(start, i);
      depth++;
    } else if (body[i] === '}') {
      depth--;
      if (depth === 0) {
        out.push([
          body.slice(start, i + 1),
          prelude
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .trim()
            .replace(/\s+/g, ' '),
        ]);
        start = i + 1;
      }
    }
  }
  return [out, body.slice(start)];
}

/** Slots positively targeted by a selector prelude (ignoring `:not(...)` exclusions like `:not([data-slot="field"])`). */
function positiveSlots(prelude) {
  let stripped = prelude;
  let prev = '';
  while (stripped !== prev) {
    prev = stripped;
    stripped = stripped.replace(/:not\([^()]*\)/g, '');
  }
  return [...stripped.matchAll(/data-slot="([a-z-]+)"/g)].map((found) => found[1]);
}

/** Trim standalone `[data-slot="..."]` selector lines in a rule prelude whose slot is not drawn by `keepSlot`. */
function trimPreludeSlotLines(ruleText, keepSlot) {
  const open = ruleText.indexOf('{');
  if (open < 0) return ruleText;
  let prelude = ruleText.slice(0, open);
  prelude = prelude.replace(/^[ \t]*\[data-slot="([a-z-]+)"\][^\n,{()]*,?\n/gm, (line, slot) => (keepSlot(slot) ? line : ''));
  prelude = prelude.replace(/,(\s*\))/g, '$1').replace(/,(\s*)$/g, '$1');
  return `${prelude}${ruleText.slice(open)}`;
}

function filterAtBlock(text, transformRule) {
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  const [inner, rest] = statements(text.slice(open + 1, close));
  const kept = inner.map(([ruleText, rulePrelude]) => transformRule(ruleText, rulePrelude)).filter(Boolean);
  if (!kept.length) return '';
  return `${text.slice(0, open + 1)}${kept.join('')}${rest}${text.slice(close)}`;
}

/** The first-paint sheet without rules or selector arms for parts no first-paint package draws, and without `said` defaults. */
export function onlyDrawn(css, families, said) {
  const open = css.indexOf('{');
  const close = css.lastIndexOf('}');
  const [all, rest] = statements(css.slice(open + 1, close));
  const drawn = (slot) => SHARED.includes(slot) || [...families].some((family) => slot === family || slot.startsWith(`${family}-`));
  const transformRule = (ruleText, rulePrelude) => {
    const slots = positiveSlots(rulePrelude);
    if (!slots.length) return ruleText;
    if (!slots.some(drawn)) return '';
    return trimPreludeSlotLines(ruleText, drawn);
  };
  const kept = all.map(([text, prelude]) => {
    if (/^:where\(:root, :host\)$/.test(prelude)) {
      // A declaration ends at a semicolon outside any parentheses; a comment before it goes with it.
      return text.replace(/(?:\s*\/\*(?:(?!\*\/)[\s\S])*\*\/)*\s*(--ui-[a-z-]+):(?:[^;(]|\([^)]*\))*;/g, (declaration, name) =>
        said.has(name) ? '' : declaration,
      );
    }
    if (prelude.startsWith('@')) return filterAtBlock(text, transformRule);
    return transformRule(text, prelude);
  });
  return `${css.slice(0, open + 1)}${kept.join('')}${rest}${css.slice(close)}`;
}

/** The lazy-surface sheet holding rules and selector arms drawn by `surfaceFamilies` (loaded in `ui-sdk-lazy` under `base`). */
export function onlySurfacesDrawn(css, coreFamilies, surfaceFamilies) {
  const open = css.indexOf('{');
  const close = css.lastIndexOf('}');
  const [all, rest] = statements(css.slice(open + 1, close));
  const coreDrawn = (slot) => SHARED.includes(slot) || [...coreFamilies].some((family) => slot === family || slot.startsWith(`${family}-`));
  const surfaceDrawn = (slot) => [...surfaceFamilies].some((family) => slot === family || slot.startsWith(`${family}-`));
  const transformRule = (ruleText, rulePrelude) => {
    const slots = positiveSlots(rulePrelude);
    if (!slots.length || !slots.some(surfaceDrawn)) return '';
    // Keep only surface-drawn standalone selector lines when trimming shared multi-selector rules.
    const trimmed = trimPreludeSlotLines(ruleText, surfaceDrawn);
    const remaining = positiveSlots(trimmed.slice(0, trimmed.indexOf('{')));
    if (!remaining.some(surfaceDrawn) && slots.some(coreDrawn)) return '';
    return trimmed;
  };
  const kept = all.map(([text, prelude]) => {
    if (/^:where\(:root, :host\)$/.test(prelude)) return '';
    if (prelude.startsWith('@')) return filterAtBlock(text, transformRule);
    return transformRule(text, prelude);
  });
  return `${css.slice(0, open + 1)}${kept.join('')}${rest}${css.slice(close)}`;
}

function tokensSaid() {
  return new Set(
    [...readFileSync(root('packages/ui/src/styles/m-tokens.css'), 'utf8').matchAll(/^\s*(--ui-[a-z-]+):/gm)].map((found) => found[1]),
  );
}

/** What the first-paint UI SDK sheet (`styles/ui-sdk.css`) holds. */
export function carried() {
  const version = JSON.parse(readFileSync(root('node_modules/@ui-sdk/core/package.json'), 'utf8')).version;
  const families = familiesDrawn();
  const said = tokensSaid();
  const head = `/* UI SDK's stylesheet (@ui-sdk/core ${version}, dist/web.css; Apache-2.0, https://github.com/vercel-labs/ui), for the
   first-paint parts the packages draw (${[...families].sort().join(', ')}), without its rules for bare
   elements and without the defaults styles/m-tokens.css says. Written by scripts/ui-sdk-css.mjs, which says why:
   edit that, not this. */\n`;
  return head + tokenizeSlotColors(onlyDrawn(withoutBareElements(readFileSync(root(SOURCE), 'utf8')), families, said));
}

/** What the lazy-surfaces UI SDK sheet (`styles/ui-sdk-surfaces.css`) holds. */
export function carriedSurfaces() {
  const version = JSON.parse(readFileSync(root('node_modules/@ui-sdk/core/package.json'), 'utf8')).version;
  const coreFamilies = familiesDrawn();
  const surfaceFamilies = surfacesFamiliesDrawn(coreFamilies);
  const head = `/* UI SDK's stylesheet (@ui-sdk/core ${version}, dist/web.css; Apache-2.0, https://github.com/vercel-labs/ui), for the
   lazy-surface parts (${[...surfaceFamilies].sort().join(', ')}) not already carried in styles/ui-sdk.css.
   Written by scripts/ui-sdk-css.mjs: edit that, not this. */\n`;
  return (
    head + tokenizeSlotColors(onlySurfacesDrawn(withoutBareElements(readFileSync(root(SOURCE), 'utf8')), coreFamilies, surfaceFamilies))
  );
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const coreText = carried();
  const surfacesText = carriedSurfaces();
  if (argv.includes('--check')) {
    if (!existsSync(root(TARGET)) || readFileSync(root(TARGET), 'utf8') !== coreText) {
      console.error(`${TARGET} is not what ${SOURCE} gives now. Run \`node scripts/ui-sdk-css.mjs\` and read the difference.`);
      exit(1);
    }
    if (!existsSync(root(SURFACES_TARGET)) || readFileSync(root(SURFACES_TARGET), 'utf8') !== surfacesText) {
      console.error(`${SURFACES_TARGET} is not what ${SOURCE} gives now. Run \`node scripts/ui-sdk-css.mjs\` and read the difference.`);
      exit(1);
    }
  } else {
    writeFileSync(root(TARGET), coreText);
    writeFileSync(root(SURFACES_TARGET), surfacesText);
  }
}
