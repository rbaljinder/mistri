import {
  Pagination,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationList,
  PaginationNext,
  PaginationPrevious,
} from '@ui-sdk/react/pagination';
import { words } from './words';

export type PagerProps = {
  pageCount: number;
  page?: number;
  onPageChange?: (page: number) => void;
};

export function Pager({ pageCount, page, onPageChange }: PagerProps) {
  return (
    <Pagination aria-label={words.pages} pageCount={pageCount} page={page} onPageChange={onPageChange} siblings={1}>
      <PaginationList>
        {({ items }) => (
          <>
            <PaginationItem>
              <PaginationPrevious aria-label={words.previousPage} />
            </PaginationItem>
            {items.map((item) => (
              <PaginationItem key={item}>
                {typeof item === 'number' ? <PaginationLink page={item} /> : <PaginationEllipsis />}
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext aria-label={words.nextPage} />
            </PaginationItem>
          </>
        )}
      </PaginationList>
    </Pagination>
  );
}
