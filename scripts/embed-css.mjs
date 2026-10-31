/**
 * The shell's stylesheets, rewritten for a host's document: what the embed
 * build (config/vite.embed.config.ts) runs every sheet through, after its @imports
 * are inlined. The served client never sees it; src/client keeps its CSS in
 * source form.
 *
 * Three hazards, in a page that is not ours (docs/design.md's cascade is
 * layers, order over specificity):
 *
 *   1. Layer names are global per document. Tailwind declares `base` and
 *      `components` too, and ours would merge with the host's. So every sheet
 *      is wrapped in `@layer tablewalk { … }`: ours become `mistri.base`,
 *      `mistri.look`, and so on, in their own order, and the host places
 *      `tablewalk` among its layers.
 *   2. Our `:root`, `html`, `body` and element rules would restyle the host.
 *      So `:root` becomes `.tw-root` (the element that stands for `<html>`),
 *      `html` becomes `div:where(.tw-root)` and `body` `div:where(.tw-body)` —
 *      each with the specificity it had, so the order inside a layer holds —
 *      and every other selector's first compound gains
 *      `:where(.tw-root, .tw-root *)`, which adds none. A selector can then
 *      match only the root and what is inside it; test/embed-css.test.ts
 *      parses the output and fails on one that could match outside.
 *   3. A host's *unlayered* rules beat any layered rule of ours. That is not
 *      fixed here (only Shadow DOM or a frame stops it); the iframe fallback is
 *      the answer for such a host.
 *
 * And `rem` is the host's: a `1rem` of ours meant 16px, and a host whose root
 * says `font-size: 62.5%` would shrink every width we set in rem. So rem
 * becomes px at the 16px it was written against.
 */

/** The class of the element that stands for `<html>`, and of the one for `<body>`. */
export const ROOT_CLASS = 'tw-root';
export const BODY_CLASS = 'tw-body';
/** The element the root sits in, which stands for the window: packages/mistri/src/embed/embedReset.css starts it from nothing. */
export const FRAME_CLASS = 'tw-frame';
const OURS = new RegExp(`\\.(${ROOT_CLASS}|${FRAME_CLASS})(?![\\w-])`);

const SCOPE = `:where(.${ROOT_CLASS}, .${ROOT_CLASS} *)`;
/* After a leading sibling combinator the first compound must be inside, not the root: a sibling of the root is the host's. */
const INSIDE = `:where(.${ROOT_CLASS} *)`;

/** Split at top-level commas (not inside parentheses, brackets or strings). */
export function splitList(selector) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const IDENT = /[\w-]/;

/** `html` and `body` as type selectors, and what each becomes. */
const TYPES = [
  ['html', `div:where(.${ROOT_CLASS})`],
  ['body', `div:where(.${BODY_CLASS})`],
];

/** `html`, `body` and `:root` where they are selectors (not inside an attribute, a string or another name). */
function replaceRoots(selector) {
  let out = '';
  let quote = '';
  let bracket = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      out += c;
      if (c === '\\') out += selector[++i] ?? '';
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '[') bracket++;
    else if (c === ']') bracket--;
    if (bracket === 0) {
      const before = selector[i - 1];
      const typeStart = before === undefined || /[\s>+~(,]/.test(before);
      const type = typeStart && TYPES.find(([word]) => selector.startsWith(word, i) && !IDENT.test(selector[i + word.length] ?? ''));
      if (type) {
        out += type[1];
        i += type[0].length - 1;
        continue;
      }
      if (selector.startsWith(':root', i) && !IDENT.test(selector[i + 5] ?? '')) {
        out += `.${ROOT_CLASS}`;
        i += 4;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** The first compound selector: up to the first combinator or space outside parentheses, brackets and strings. */
export function firstCompound(selector) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) return { compound: selector.slice(0, i), rest: selector.slice(i) };
  }
  return { compound: selector, rest: '' };
}

/** One selector, scoped. */
export function scopeSelector(selector) {
  const rooted = replaceRoots(selector);
  const { compound, rest } = firstCompound(rooted);
  /* Already the root (it was `:root` or `html`) or its frame: it and what is under it are ours. */
  if (OURS.test(compound)) return rooted;
  const scope = /^\s*[+~]/.test(rest) ? INSIDE : SCOPE;
  /* Before a pseudo-element, which must end its compound. */
  const pseudo = compound.search(/::/);
  return pseudo === -1 ? `${compound}${scope}${rest}` : `${compound.slice(0, pseudo)}${scope}${compound.slice(pseudo)}${rest}`;
}

/** Every selector in a rule's list, scoped. */
export const scopeSelectorList = (list) => splitList(list).map(scopeSelector).join(',\n');

const REM = /(-?\d*\.?\d+)rem\b/g;
const px = (value) => value.replace(REM, (_, n) => `${+(Number(n) * 16).toFixed(4)}px`);

/** Whether a rule's selectors are selectors (not a keyframe's `from`/`50%`, not a nested rule's `&`). */
function scoped(rule) {
  for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
    if (parent.type === 'rule') return false;
    if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return false;
    if (parent.type === 'atrule' && parent.name === 'page') return false;
  }
  return true;
}

/**
 * The PostCSS plugin. `layer` is the one layer everything is nested in;
 * `only` says, by file, which sheets are the shell's.
 * @param {{ layer?: string, only?: (file: string) => boolean }} [options]
 */
export function tablewalkScope({ layer = 'tablewalk', only = () => true } = {}) {
  return {
    postcssPlugin: 'mistri-embed-scope',
    OnceExit(root, { AtRule }) {
      /* A sheet that is not the shell's (a test host's own, served by the same Vite) is left as written. */
      if (!only(root.source?.input.file ?? '')) return;
      root.walkRules((rule) => {
        if (scoped(rule)) rule.selector = scopeSelectorList(rule.selector);
      });
      root.walkDecls((decl) => {
        if (decl.value.includes('rem')) decl.value = px(decl.value);
      });
      const wrapper = new AtRule({ name: 'layer', params: layer });
      const kept = [];
      for (const node of [...root.nodes]) {
        /* @charset and @namespace must stay first and outside; @import is already inlined. */
        if (node.type === 'atrule' && ['charset', 'namespace', 'import'].includes(node.name)) kept.push(node);
        else wrapper.append(node.remove());
      }
      root.removeAll();
      root.append(...kept, wrapper);
    },
  };
}
tablewalkScope.postcss = true;
