/**
 * Whether nothing should enter: the reader asked their system for reduced motion, or the worn theme's pace is
 * `still` (`data-look-motion`, themeFamilies.css). The sheets answer both by themselves; this is for the few
 * enters a script draws (a navigation's settle, a record's fade), which would otherwise read a 0ms token as "no
 * token" and fall back to the house's duration.
 */
import { shellRoot } from './shellHost.js';

export function motionStill(): boolean {
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  } catch {
    return true;
  }
  return shellRoot().dataset.lookMotion === 'still';
}
