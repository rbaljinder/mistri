/** Drafts retain every compiled section; the parser checks them at the save/export boundary. */
import { pageConfig, parsePagesConfig, type PageDef } from '@mistriwork/engine/shared/page.js';
import { say } from '../copy/record/components/pageDraft.js';

export type PageDraft = PageDef;

export function checkedDraft(draft: PageDraft): PageDef {
  if (!draft.sections.length) throw new Error(say('aPageNeedsAtLeast'));
  parsePagesConfig({ pages: [pageConfig(draft)] }, say('pageEditor'));
  // Validate authored meaning without replacing saved identity or explicit layout defaults.
  return structuredClone(draft);
}

/**
 * The page as it would appear in tablewalk.json.
 *
 * The same shape the parser reads, not a description of it: a builder that
 * emitted a near-miss would be a builder whose output someone has to correct
 * before it works, which is worse than no button. `id` and `source` are left
 * out because the file gives its own.
 */
export function asConfig(page: PageDef): string {
  return JSON.stringify({ pages: [pageConfig(page)] }, null, 2);
}
