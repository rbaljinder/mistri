/**
 * The product's main, which the page's entry starts (shellStart.js). No file of the kit's answers this name: the
 * product's build does, with its own main (`@mistriwork/kit/vite`, `shellMain`), so the kit names neither product.
 */
declare module 'virtual:mistri/shell-main' {
  /** Everything the product does once the look is worn: its own steps, then the kit's shell (shells.ts `ShellMain`). */
  export function start(): Promise<void>;
}
