/* What the parts that draw a range (SpansAxis, SpansNow, SpansRegion) need of the Spans around them: the range
   and the way it runs, and the regions that refuse a stretch, which the root asks about before a change is final. */
import { createContext } from 'react';

export type SpansRegionEntry = { from: number; to: number; track?: string; label: string };

export type SpansRange = {
  min: number;
  max: number;
  axis: 'x' | 'y';
  /* Regions by the id each registered under. */
  regions: Map<string, SpansRegionEntry>;
};

export const SpansRangeContext = createContext<SpansRange>({ min: 0, max: 100, axis: 'x', regions: new Map() });

/** Where a value is along the range, as a share of it, kept to the range's ends. */
export const share = (range: Pick<SpansRange, 'min' | 'max'>, value: number): number =>
  range.max === range.min ? 0 : Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));

/** The region that a stretch from `start` to `end` on `track` would overlap, if any. */
export function refusedBy(range: SpansRange, track: string, start: number, end: number): SpansRegionEntry | undefined {
  for (const region of range.regions.values())
    if ((region.track === undefined || region.track === track) && start < region.to && end > region.from) return region;
  return undefined;
}
