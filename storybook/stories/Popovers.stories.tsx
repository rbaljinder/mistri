import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Dropdown } from '../../packages/kit/src/client/components/Dropdown.js';
import { DateField } from '../../packages/kit/src/client/components/DateField.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';
import { DropMenu, DropItem } from '@mistriwork/ui/DropMenu.js';
import { openPalette } from '../../packages/kit/src/client/palette.js';
import { Palette as PaletteSurface } from '../../packages/kit/src/client/components/Palette.js';
import { registerSurface } from '../../packages/kit/src/client/surfaces.js';
import { taskApp } from './taskFixture.js';

/* Every floating surface, open. A popover is where a look's ground, ring and
   shadow meet the page under it, and the one place a capture at rest never
   shows: each story opens its own in its play function. */
const meta = { title: 'Forms/Open popovers', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;

const body = () => within(document.body);
const field = (label: string, control: React.ReactNode, id?: string) => (
  <div className="insert-field" style={{ maxWidth: 360 }}>
    {id ? <label htmlFor={id}>{label}</label> : <label>{label}</label>}
    {control}
  </div>
);

export const Select: StoryObj = {
  render: function Open() {
    const [team, setTeam] = useState('design');
    return (
      <div className="insert-fields">
        {field(
          'Team',
          <Dropdown
            ariaLabel="Team"
            value={team}
            onChange={setTeam}
            items={[
              { value: 'design', label: 'Design' },
              { value: 'engineering', label: 'Engineering', detail: 'Platform & product' },
              { value: 'people', label: 'People' },
              { value: 'support', label: 'Customer support', detail: 'Tier 1 and 2' },
            ]}
          />,
        )}
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Team' }));
    await expect(await body().findByRole('listbox')).toBeInTheDocument();
  },
};

export const TypeaheadResults: StoryObj = {
  render: function Open() {
    const [text, setText] = useState('');
    const [open, setOpen] = useState(false);
    const people = ['Maya Chen', 'Mateo Alvarez', 'Owen Brooks', 'Priya Shah', 'Noah Williams'];
    return (
      <div className="insert-fields">
        {field(
          'Manager',
          <div className="picker">
            <Typeahead
              text={text}
              onText={setText}
              items={people.filter((name) => name.toLowerCase().includes(text.toLowerCase()))}
              itemKey={(name) => name}
              itemLabel={(name) => name}
              itemClassName={() => 'picker-option'}
              renderItem={(name) => name}
              onPick={(name) => {
                setText(name);
                setOpen(false);
              }}
              open={open}
              onOpenChange={setOpen}
              inputProps={{ id: 'manager', className: 'picker-input', placeholder: 'Find a teammate' }}
              popupClassName="picker-popup"
              listClassName="picker-list"
              empty="No matching teammates"
            />
          </div>,
          'manager',
        )}
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByLabelText('Manager'), 'ma');
    await expect(await body().findByRole('listbox')).toBeInTheDocument();
  },
};

export const DatePicker: StoryObj = {
  render: function Open() {
    const [date, setDate] = useState('2026-09-22');
    return <div className="insert-fields">{field('Start date', <DateField id="start" value={date} onChange={setDate} />, 'start')}</div>;
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Choose date/ }));
    await expect(await body().findByRole('dialog')).toBeInTheDocument();
  },
};

export const Menu: StoryObj = {
  render: () => (
    <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: 480 }}>
      <DropMenu className="page-actions-more" triggerClassName="ghost" label="More" popupClassName="page-actions-popup" align="end">
        <DropItem className="page-actions-item" onClick={() => {}}>
          Duplicate
        </DropItem>
        <DropItem className="page-actions-item" onClick={() => {}}>
          Copy link
        </DropItem>
        <DropItem className="page-actions-item" disabled onClick={() => {}}>
          Archive
        </DropItem>
        <DropItem className="page-actions-item is-danger" onClick={() => {}}>
          Delete…
        </DropItem>
      </DropMenu>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'More' }));
    await expect(await body().findByRole('menu')).toBeInTheDocument();
  },
};

/* The palette (⌘K), over an App: its rooms first, then what it has read. The shell hands the store its component at
   startup (surfaces.js); a story has no shell, so it does the same. */
registerSurface('palette', PaletteSurface);
export const Palette: StoryObj = {
  beforeEach: async () => {
    await taskApp();
  },
  render: function Open() {
    useEffect(() => {
      openPalette('ta');
      /* The palette lives outside the story's tree and opens once per page;
         closing it on the way out lets the next visit to this story open it again. */
      return () => {
        document.querySelector('.palette-host input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      };
    }, []);
    return <p className="note">The palette is open over this page.</p>;
  },
  play: async () => {
    await expect(await body().findByRole('combobox', { name: 'Search' })).toBeInTheDocument();
  },
};
