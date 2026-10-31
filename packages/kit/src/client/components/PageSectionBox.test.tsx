/**
 * A section's head: an untitled list says its table as words, and so does a suggested page's list, which is titled by
 * the bare table name (`visit_attachment`). A title an author wrote is left as written.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createContext } from 'react';

vi.mock('../core.js', () => ({ disclosure: () => {}, findTable: () => undefined }));
vi.mock('./pageContext.js', () => ({
  PageRenderContext: createContext({ preview: false }),
  spoken: (name: string) => name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
}));
vi.mock('./listNavigation.js', () => ({ useListNavigation: () => () => {} }));
vi.mock('./useMessageLanguage.js', () => ({ useMessageLanguage: () => {} }));

const { SectionBox } = await import('./PageSectionBox.js');
afterEach(cleanup);

const head = (title: string | undefined) => {
  render(
    <SectionBox
      section={{ kind: 'list', from: 'visit_attachment', ...(title ? { title } : {}) } as never}
      body={<p>rows</p>}
      foldable={false}
    />,
  );
  return screen.getByRole('heading', { level: 2 }).textContent;
};

test('a suggested list titled by its raw table name is headed in words; an authored title is not touched', () => {
  expect(head('visit_attachment')).toBe('Visit attachment');
  cleanup();
  expect(head('Open claims')).toBe('Open claims');
  cleanup();
  expect(head('Claims via visit_id')).toBe('Claims via visit_id');
  cleanup();
  expect(head(undefined)).toBe('Visit attachment');
});
