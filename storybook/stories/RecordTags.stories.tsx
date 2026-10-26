import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { AppTagRule } from '../../packages/mistri/src/shared/app.js';
import { RecordTags } from '../../packages/kit/src/client/components/RecordTags.js';
import { fixture } from '../mocks/core.js';

const col = (name: string, primary = false) => ({ name, type: primary ? 'INTEGER' : 'TEXT', nullable: !primary, primaryKey: primary });
const issueLabel: TableMeta = {
  id: 'issue_label',
  name: 'issue_label',
  schema: '',
  isView: false,
  columns: [col('id', true), col('issue_id'), col('label_id')],
};
const label: TableMeta = { id: 'label', name: 'label', schema: '', isView: false, columns: [col('id', true), col('name'), col('tone')] };
const rule: AppTagRule = {
  through: 'issue_label',
  to: 'label',
  from: 'issue_id',
  key: 'id',
  via: 'label_id',
  tagKey: 'id',
  label: 'name',
  tone: 'tone',
};

const labels = [
  { id: 1, name: 'bug', tone: 'bad' },
  { id: 2, name: 'design', tone: 'info' },
  { id: 3, name: 'needs-review', tone: 'warn' },
  { id: 4, name: 'shipped', tone: 'good' },
];
const links = [
  { id: 10, label_id: 1 },
  { id: 11, label_id: 2 },
  { id: 12, label_id: 3 },
].map((link) => {
  const tag = labels.find((item) => item.id === link.label_id)!;
  return { ...link, 'label_id.name': tag.name, 'label_id.tone': tag.tone };
});

const meta = {
  title: 'Records/Tags',
  component: RecordTags,
  args: { rule, recordKey: { id: 1 } },
  beforeEach: () => {
    fixture({
      tables: [issueLabel, label],
      foreignKeys: [
        { name: 'story_reference', from: { table: 'issue_label', columns: ['label_id'] }, to: { table: 'label', columns: ['id'] } },
      ],
      answer: {
        // The link rows for the record, and the tags a pick offers.
        '/api/run': ({ q }: { q?: string }) => ({ rows: String(q).startsWith('issue_label') ? links : labels, errors: [] }),
        '/api/insert': () => ({ ok: true }),
        '/api/delete': () => ({ ok: true }),
      },
    });
  },
} satisfies Meta<typeof RecordTags>;
export default meta;

/* Chips in the tone each tag carries; × removes one, + adds one. */
export const Chips: StoryObj<typeof meta> = {};
