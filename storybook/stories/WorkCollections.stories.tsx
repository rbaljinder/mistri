import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TriageBoard, type TriageCard } from '../../packages/mistri/src/client/components/TriageBoard.js';
import { Checklist } from '../../packages/mistri/src/client/components/Checklist.js';
import { SplitListDetail } from '../../packages/mistri/src/client/components/SplitListDetail.js';
import { DashboardNote } from '../../packages/kit/src/client/components/DashboardNote.js';
import { fixture } from '../mocks/core.js';

const table = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'completed', type: 'BOOLEAN', nullable: true, primaryKey: false },
  ],
};
const rows = [
  { id: 1, name: 'Prepare the onboarding plan', completed: false },
  { id: 2, name: 'Review the handover notes', completed: true },
  { id: 3, name: 'Confirm the customer’s accessibility and language preferences', completed: false },
];
const lanes = [
  { id: 'planned', label: 'Planned' },
  { id: 'working', label: 'In progress', limit: 2 },
  { id: 'done', label: 'Complete' },
];
const cards: TriageCard[] = rows.map((row, index) => ({
  id: String(row.id),
  title: row.name,
  laneId: index === 1 ? 'done' : 'planned',
  subtitle: 'Customer experience',
  meta: 'Due October 2',
}));
const meta = {
  title: 'Lists/Work collections',
  beforeEach: () => {
    fixture({ tables: [table], writable: false });
  },
} satisfies Meta;
export default meta;
function Board({ empty = false }: { empty?: boolean }) {
  const [items, setItems] = useState(empty ? [] : cards);
  const [announcement, setAnnouncement] = useState('');
  return (
    <TriageBoard
      ariaLabel="Onboarding work"
      lanes={lanes}
      cards={items}
      announcement={announcement}
      onMove={(card, to) => {
        setItems((current) => current.map((item) => (item.id === card.id ? { ...item, laneId: to.lane } : item)));
        setAnnouncement(`${card.title} moved to ${lanes.find((lane) => lane.id === to.lane)?.label}.`);
      }}
    />
  );
}
export const BoardLanes: StoryObj = { render: () => <Board /> };
export const EmptyBoard: StoryObj = { render: () => <Board empty /> };
export const ReadOnlyChecklist: StoryObj = {
  render: () => (
    <Checklist table={table} rows={rows} spec={{ kind: 'checklist', primary: 'name', checked: 'completed' }} interactive={false} />
  ),
};
/* The App draws the list side with its own grid (Rooms.tsx, SplitRecordRoom),
   whose rows stand under hairlines and whose current row is a tint in the
   accent's ink; the story draws the same rows as that grid does. */
function Inbox({ initial = null }: { initial?: number | null }) {
  const [selected, setSelected] = useState<number | null>(initial);
  return (
    <SplitListDetail
      selected={selected !== null}
      detailTitle="Task details"
      onCloseDetail={() => setSelected(null)}
      listLabel="Tasks"
      list={
        <div className="table-wrap">
          <table>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  aria-current={selected === row.id ? 'true' : undefined}
                  tabIndex={0}
                  onClick={() => setSelected(row.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>{row.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
      detail={
        selected !== null && (
          <DashboardNote
            title={rows.find((row) => row.id === selected)!.name}
            text="Coordinate with the customer experience team before completing this task."
          />
        )
      }
    />
  );
}
export const SplitInbox: StoryObj = { render: () => <Inbox /> };
export const SplitInboxSelected: StoryObj = { render: () => <Inbox initial={2} /> };
