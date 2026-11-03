import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { TreePicker, type TreeAsk, type TreeValue } from '../../packages/kit/src/client/components/TreePicker.js';

/* A category hierarchy: two records of one name under different parents, told apart by their paths. */
const rows = [
  { id: 1, name: 'Hardware', parent_id: null },
  { id: 2, name: 'Software', parent_id: null },
  { id: 3, name: 'Network', parent_id: null },
  { id: 4, name: 'Laptops', parent_id: 1 },
  { id: 5, name: 'Printers', parent_id: 1 },
  { id: 6, name: 'Batteries', parent_id: 4 },
  { id: 7, name: 'Screens', parent_id: 4 },
  { id: 8, name: 'Batteries', parent_id: 5 },
  { id: 9, name: 'Email', parent_id: 2 },
  { id: 10, name: 'VPN', parent_id: 3 },
  { id: 11, name: 'Wi-Fi', parent_id: 3 },
];
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const ids = (text: string) => text.split(',').map((part) => Number(part.trim()));

/* The server's answers to the picker's reads, from the rows above: a level, its branches, a search, a path. */
const ask: TreeAsk = async (path, body) => {
  const text = String(body.q ?? body.text);
  let m: RegExpMatchArray | null;
  if (path === '/api/breakdown' && (m = text.match(/parent_id in \(([^)]*)\)/)))
    return {
      rows: ids(m[1]).flatMap((parent) => {
        const children = rows.filter((row) => row.parent_id === parent).length;
        return children ? [{ parent_id: parent, children }] : [];
      }),
    };
  if (/parent_id is empty/.test(text)) return { rows: rows.filter((row) => row.parent_id === null).sort(byName) };
  if ((m = text.match(/parent_id = (\d+)/))) return { rows: rows.filter((row) => row.parent_id === Number(m![1])).sort(byName) };
  if ((m = text.match(/name contains "([^"]*)"/)))
    return { rows: rows.filter((row) => row.name.toLowerCase().includes(m![1].toLowerCase())).sort(byName) };
  if ((m = text.match(/id in \(([^)]*)\)/))) return { rows: rows.filter((row) => ids(m![1]).includes(row.id)) };
  if ((m = text.match(/id = (\d+)/))) return { rows: rows.filter((row) => row.id === Number(m![1])) };
  return { rows: [] };
};

function Field({ start = '' }: { start?: TreeValue | '' }) {
  const [value, setValue] = useState<TreeValue | ''>(start);
  return (
    <label style={{ display: 'grid', gap: 6, maxWidth: 360 }}>
      <span>Category</span>
      <TreePicker
        from="category"
        by="id"
        labelColumn="name"
        parent="parent_id"
        ask={ask}
        scope="story"
        value={value}
        onChange={setValue}
        ariaLabel="Category"
      />
    </label>
  );
}

const meta = { title: 'Forms/Tree picker', component: Field, parameters: { layout: 'padded' } } satisfies Meta<typeof Field>;
export default meta;

/* Opens on the records with no parent; a caret where there are children, read as a branch opens. */
export const Empty: StoryObj<typeof meta> = {};
/* A chosen record is said with its path under the box, and the tree opens down to it. */
export const Chosen: StoryObj<typeof meta> = { args: { start: 8 } };
