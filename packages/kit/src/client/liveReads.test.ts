/** `mistri-reads`: the header's tables are kept against the answer, then the query, and forgotten with it. */
import { expect, test } from 'vitest';
import { QueryCache, QueryClient } from '@tanstack/react-query';
import { fileQueryReads, fileReads, parseReads, queryReads, readsOf } from './liveReads.js';

test('a header names its tables, an encoded comma stays inside its id', () => {
  expect(parseReads('job,ledger')).toEqual(['job', 'ledger']);
  expect(parseReads('a%2Cb,c')).toEqual(['a,b', 'c']);
  expect(parseReads('')).toBeUndefined();
  expect(parseReads(null)).toBeUndefined();
  expect(parseReads('%E0%A4%A')).toBeUndefined();
});

test('the tables are kept against the parsed answer, and an answer with no header has none', () => {
  const answer = { rows: [] };
  fileReads(answer, 'job');
  expect(readsOf(answer)).toEqual(['job']);
  const bare = { rows: [] };
  fileReads(bare, null);
  expect(readsOf(bare)).toBeUndefined();
  expect(() => fileReads('text', 'job')).not.toThrow();
});

test("a query holds its answer's tables while it is cached, and not after it is removed", async () => {
  const cache = new QueryCache({ onSuccess: fileQueryReads });
  const client = new QueryClient({ queryCache: cache });
  await client.fetchQuery({
    queryKey: ['count', 'spoke', 'x'],
    queryFn: () => {
      const answer = { count: 3 };
      fileReads(answer, 'job');
      return answer;
    },
  });
  const hash = cache.getAll()[0].queryHash;
  expect(queryReads(hash)).toEqual(['job']);
  /* A later answer without the header clears what the earlier one said: the family's own rule applies again. */
  await client.fetchQuery({ queryKey: ['count', 'spoke', 'x'], staleTime: 0, queryFn: () => ({ count: 4 }) });
  expect(queryReads(hash)).toBeUndefined();
});
