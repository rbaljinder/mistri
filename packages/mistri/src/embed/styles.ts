/**
 * The shell's stylesheets in a host's document, without a `<link>` or a
 * `<style>` of ours anywhere in it.
 *
 * The embed build turns every stylesheet the shell imports into a string,
 * already scoped to `.tw-root` and nested in one `@layer mistri`
 * (scripts/embed-css.mjs), and a module that hands the string here
 * (config/vite.embed.config.ts, `adoptedCss`). Each becomes a constructed sheet,
 * adopted by the document while a mistri element is on the page and taken
 * back when the last one leaves. A constructed sheet is CSSOM, so a host CSP
 * without `'unsafe-inline'` still applies it, and a host that never renders
 * mistri never sees a rule of ours.
 *
 * Order is arrival order, which is the shell's import order: the first sheet
 * declares the layers inside `mistri`, and a part's sheet loaded on demand
 * (a chart, a look) comes after, as its `<link>` would when served.
 */
const texts: string[] = [];
let made: CSSStyleSheet[] = [];
let holders = 0;

function ours(): CSSStyleSheet[] {
  while (made.length < texts.length) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(texts[made.length]);
    made.push(sheet);
  }
  return made;
}

function apply(): void {
  const mine = new Set(made);
  const theirs = document.adoptedStyleSheets.filter((sheet) => !mine.has(sheet));
  document.adoptedStyleSheets = holders > 0 ? [...theirs, ...ours()] : theirs;
}

/** A stylesheet the shell imported (called by the build's CSS modules, once each, in import order). */
export function adoptCss(css: string): void {
  texts.push(css);
  if (holders > 0) apply();
}

/** A mistri element is on the page: the sheets are adopted. Returns the release. */
export function holdStyles(): () => void {
  holders++;
  apply();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    apply();
  };
}
