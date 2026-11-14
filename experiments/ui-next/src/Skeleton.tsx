import type { CSSProperties } from 'react';

/* The place of something not read yet, at the size it will have: a page that waits in its own shape does not jump
   when the rows arrive, and reads as nearly there. It says nothing to a screen reader; whatever holds it says
   `aria-busy`. */
export function Skeleton({ width, height }: { width?: string; height?: string }) {
  return <span data-slot="skeleton" aria-hidden="true" style={{ '--w': width, '--h': height } as CSSProperties} />;
}
