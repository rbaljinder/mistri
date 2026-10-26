/**
 * A free-form page's body (CustomSection.tsx's CustomPageBody), loaded by Rooms.tsx the first time a page is opened,
 * and with it how the page's blocks load (pageBlocks.ts). Here rather than in CustomSection.tsx, which every custom
 * section and value renderer reaches: the blocks are the platform's rooms, and those reach CustomSection.tsx again.
 */
import { registerPageBlocks } from './pageBlocks.js';

registerPageBlocks(() => import('./blocks.js'));

export { CustomPageBody } from './CustomSection.js';
