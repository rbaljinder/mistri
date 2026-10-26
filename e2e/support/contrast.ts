import type { Page } from './harness';
import { contrastReadings } from '../../packages/mistri/src/server/build/gradeProbe';

/* What a reader reads, measured where it is drawn: status words, avatars, a
   filled tab, a calendar's dates and placeholders at 4.5:1, and every field's
   edge at 3:1 (gradeProbe.ts says which and how). `extra` adds states a spec
   puts the page in — a hover, a press, an error — as [selector, need] pairs;
   each must match something drawn, so a renamed selector cannot pass by
   matching nothing. The reading is the one `mistri grade` takes, so the
   suite and the grader hold a page to one rule. */
export const readings = (page: Page, extra: ReadonlyArray<readonly [string, number]> = []) =>
  page.evaluate(contrastReadings, { states: extra.map(([selector, need]) => [selector, need] as [string, number]) });
