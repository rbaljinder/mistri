import { Avatar as Disc, AvatarFallback, AvatarImage } from '@ui-sdk/react/avatar';
import {
  Pagination as Pages,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationList,
  PaginationNext,
  PaginationPrevious,
} from '@ui-sdk/react/pagination';
import { Tabs as TabSet, TabsIndicator, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import type { UiKitSlots } from '@mistriwork/ui/UiKit.js';
import { told } from './told';

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/* A letter is a grapheme, not a UTF-16 unit: slicing one would split an emoji or an astral letter. */
function firstLetter(word: string): string {
  const first = graphemes ? graphemes.segment(word)[Symbol.iterator]().next().value?.segment : Array.from(word)[0];
  return (first ?? '').toUpperCase();
}

/* The first letters of the first two words of a name: "Ada Lovelace" is AL, "Ada" is A. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length ? firstLetter(words[0]!) + (words[1] ? firstLetter(words[1]) : '') : '';
}

/* One panel at a time, chosen from a row. Panels are the tab's own children. */
export const Tabs: UiKitSlots['Tabs'] = ({ tabs, value, defaultValue, onValueChange, className, ariaLabel }) => (
  <TabSet
    className={className}
    value={value}
    defaultValue={value === undefined ? (defaultValue ?? tabs.find((tab) => !tab.disabled)?.value) : undefined}
    onValueChange={onValueChange && ((next, details) => next !== null && onValueChange(String(next), told('select', details)))}
  >
    <TabsList aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <TabsTab key={tab.value} value={tab.value} disabled={tab.disabled}>
          {tab.label}
        </TabsTab>
      ))}
      <TabsIndicator />
    </TabsList>
    {tabs.map((tab) => (
      <TabsPanel key={tab.value} value={tab.value} data-kind="kit">
        {tab.children}
      </TabsPanel>
    ))}
  </TabSet>
);

/* The pages of a list. With one page or none the row draws nothing: a pager for a single page is noise. */
export const Pagination: UiKitSlots['Pagination'] = ({ page, pages, onPageChange, ariaLabel, words }) => {
  if (pages <= 1) return null;
  return (
    <Pages
      aria-label={ariaLabel ?? words?.pages ?? 'Pages'}
      page={Math.min(Math.max(page, 1), pages)}
      pageCount={pages}
      siblings={2}
      onPageChange={(next, details) => onPageChange(next, told('page-press', details))}
    >
      <PaginationList>
        {({ items }) => (
          <>
            <PaginationItem>
              <PaginationPrevious data-kind="words">{words?.previous ?? 'Previous'}</PaginationPrevious>
            </PaginationItem>
            {items.map((item) => (
              <PaginationItem key={item}>
                {typeof item === 'number' ? <PaginationLink page={item} /> : <PaginationEllipsis />}
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext data-kind="words">{words?.next ?? 'Next'}</PaginationNext>
            </PaginationItem>
          </>
        )}
      </PaginationList>
    </Pages>
  );
};

/* A person's picture, or their initials where there is none. The disc is decorative: a name that matters is said
   beside it by the caller. */
export const Avatar: UiKitSlots['Avatar'] = ({ name, src, size = 'md', className }) => (
  <Disc className={className} data-size={size}>
    {src ? <AvatarImage src={src} alt="" /> : null}
    <AvatarFallback aria-hidden="true">{name ? initialsOf(name) : ''}</AvatarFallback>
  </Disc>
);
