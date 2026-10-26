import type { Meta, StoryObj } from '@storybook/react-vite';
import { AttachmentList } from '../../packages/kit/src/client/components/AttachmentList.js';

const items = [
  { id: '1', name: 'repro-steps.txt', href: '#', meta: ['87 bytes', 'yesterday'] },
  { id: '2', name: 'crash-report.json', href: '#', meta: ['14 kB', '3 days ago'] },
  { id: '3', name: 'layout-before.png', href: '#', meta: ['412 kB', 'Aug 1, 2026'] },
  { id: '4', name: 'contract', href: '#', meta: [] },
];

/* `send` answers null for a file kept, or why it was refused. */
const upload = {
  label: 'Attach file',
  maxBytes: 2 << 20,
  send: async (file: File) => (file.name.endsWith('.exe') ? 'Programs cannot be attached here.' : null),
};

/* Where the reader may change the files: a rename that refuses a taken name, and a remove. */
const editable = items.map((item) => ({
  ...item,
  onOpen: () => undefined,
  rename: async (name: string) => (name === 'contract' ? 'Another file is already called that.' : null),
  remove: async () => null,
}));

const meta = { title: 'Records/Attachments', component: AttachmentList, args: { emptyText: 'No attachments yet.' } } satisfies Meta<
  typeof AttachmentList
>;
export default meta;

export const Files: StoryObj<typeof meta> = { args: { items } };
export const WithUpload: StoryObj<typeof meta> = { args: { items, upload } };
export const Editable: StoryObj<typeof meta> = { args: { items: editable, upload } };
export const Empty: StoryObj<typeof meta> = { args: { items: [], upload } };
