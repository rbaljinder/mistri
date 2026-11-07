/**
 * How many rows a list page holds until the reader chooses: the size the server reads a list's first page at, so the
 * page it draws is the page the browser would ask for, and one a reader may pick (the size menu offers it).
 */
import { beforeEach, expect, test } from 'vitest';
import { LIST_PAGE_SIZE } from '@mistriwork/engine/shared/reads.js';
import { PAGE_SIZES, pageSize, setPageSize } from './core.js';

beforeEach(() => window.localStorage.clear());

test('a list opens on fifty rows, the size the server reads for the first paint', () => {
  expect(LIST_PAGE_SIZE).toBe(50);
  setPageSize('not a size');
  expect(pageSize()).toBe(LIST_PAGE_SIZE);
  expect(PAGE_SIZES).toContain(LIST_PAGE_SIZE);
});

test("the reader's own size is kept", () => {
  setPageSize(100);
  expect(pageSize()).toBe(100);
});
