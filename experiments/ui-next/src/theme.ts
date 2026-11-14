/* Wearing a theme where mistri is not there to put it on: a page of ui-next's own, a preview of one theme beside
   another. A theme arrives worked out (`WornTheme`): the attributes its recipes are worn as and its tokens by
   mode, which is what mistri's own compiler gives for a built-in look, a palette or an App's `defineTheme`.
   ui-next does not work a theme out and has no theme language of its own; it wears mistri's. Inside an App
   nothing here is called: mistri has already dressed the root, and the sheets (theme/bridge.css, theme/looks.css)
   read what it put there. */

export type WornTheme = {
  /* `data-look-tabs: 'pill'` and the rest: one attribute a recipe. */
  attributes: Record<string, string>;
  /* The theme's tokens by what they are for (`--accent`, `--ground`), in each mode. */
  light: Record<string, string>;
  dark: Record<string, string>;
};

const COLOUR = /^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color|light-dark|transparent|currentcolor|[a-z]+$)/i;
const worn = new WeakMap<HTMLElement, { attributes: string[]; tokens: string[] }>();

/* Puts a theme on an element (the page's root unless another is named), and takes off what the last one put
   there. A colour is written once for both modes (`light-dark()`), so the element follows the reader's mode, or
   its own `color-scheme` where a preview pins one. `null` takes the theme off. */
export function wearTheme(theme: WornTheme | null, on: HTMLElement = document.documentElement): void {
  const before = worn.get(on);
  for (const name of before?.attributes ?? []) on.removeAttribute(name);
  for (const name of before?.tokens ?? []) on.style.removeProperty(name);
  if (!theme) {
    on.removeAttribute('data-custom-theme');
    worn.delete(on);
    return;
  }
  on.setAttribute('data-custom-theme', '');
  for (const [name, value] of Object.entries(theme.attributes)) on.setAttribute(name, value);
  const names = [...new Set([...Object.keys(theme.light), ...Object.keys(theme.dark)])];
  for (const name of names) {
    const light = theme.light[name] ?? theme.dark[name] ?? '';
    const dark = theme.dark[name] ?? light;
    // Only a colour can be said for both modes at once; a width or a face is the same in each.
    on.style.setProperty(name, light !== dark && COLOUR.test(light) && COLOUR.test(dark) ? `light-dark(${light}, ${dark})` : light);
  }
  worn.set(on, { attributes: Object.keys(theme.attributes), tokens: names });
}
