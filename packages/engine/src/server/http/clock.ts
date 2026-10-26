/**
 * The wall clock, unless a test has pinned it: MISTRI_CLOCK holds an
 * instant the browser suite fixes so that "last 90 days" over a database
 * seeded for a known day reads the same on every run, and a stamp an action
 * writes ('now') is the same instant on every run. Never set in use.
 */
import { productEnv } from '../product.js';
export function clockNow(): Date {
  const pinned = productEnv('CLOCK');
  if (!pinned) return new Date();
  const at = new Date(pinned);
  return Number.isNaN(at.getTime()) ? new Date() : at;
}
