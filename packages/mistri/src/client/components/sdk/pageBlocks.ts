/**
 * How `@mistriwork/mistri/page`'s blocks load, handed in by the module that draws a free-form page (CustomPage.tsx).
 *
 * The blocks (blocks.tsx) are the platform's rooms — a dashboard, a record page, a tree — and those draw values and
 * sections that are components, which reach `@mistriwork/mistri/page` again through the host (host.tsx). Were page.tsx to
 * import the blocks, even lazily, the SDK would join the page's tangle of imports (test/repo/runtime-cycles), as
 * uiBridge.ts says of navigation; so it imports nothing of them, and the page's drawer registers here.
 */
let load: (() => Promise<unknown>) | undefined;

export function registerPageBlocks(blocks: () => Promise<unknown>): void {
  load = blocks;
}

/** The blocks module, once a page has said how it loads; a refusal otherwise, which the part says as one it could not load. */
export function pageBlocks<M>(unregistered: string): Promise<M> {
  return (load?.() ?? Promise.reject(new Error(unregistered))) as Promise<M>;
}
