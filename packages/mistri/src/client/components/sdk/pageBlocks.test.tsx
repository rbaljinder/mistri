/**
 * `@mistriwork/mistri/page`'s blocks load through the module that draws a free-form page (CustomPage.tsx), which hands in how
 * (pageBlocks.ts): page.tsx imports none of the platform's rooms, so the SDK stays out of their tangle of imports.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { pageBlocks } from './pageBlocks.js';

vi.mock('./CustomSection.js', () => ({ CustomPageBody: () => null }));
vi.mock('./blocks.js', () => ({ Rows: ({ from }: { from: string }) => <p>The platform’s list of {from}</p> }));

afterEach(cleanup);

test('before a page has said how its blocks load, asking for them is refused in the words handed in', async () => {
  await expect(pageBlocks('No page has said.')).rejects.toThrow('No page has said.');
});

test('a page drawn in an App draws its blocks from the module that drew it', async () => {
  await import('./CustomPage.js');
  const { Rows } = await import('./page.js');
  render(<Rows from="task" />);
  expect(await screen.findByText('The platform’s list of task')).toBeVisible();
});
