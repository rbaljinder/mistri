import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Dropdown } from '../../packages/kit/src/client/components/Dropdown.js';
import { DateField } from '../../packages/kit/src/client/components/DateField.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';

const meta = { title: 'Forms/Controls', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;

function Controls({ disabled = false, invalid = false }: { disabled?: boolean; invalid?: boolean }) {
  const [team, setTeam] = useState('design');
  const [date, setDate] = useState('2026-09-22');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const people = ['Maya Chen', 'Owen Brooks', 'Priya Shah', 'Noah Williams'];
  return (
    <div className="insert-fields" style={{ maxWidth: 520 }}>
      <div className="insert-field">
        <label htmlFor="person-name">Name</label>
        <input className="insert-input" id="person-name" defaultValue="Maya Chen" disabled={disabled} aria-invalid={invalid || undefined} />
      </div>
      <div className="insert-field">
        <label>Team</label>
        <Dropdown
          ariaLabel="Team"
          value={team}
          onChange={setTeam}
          disabled={disabled}
          ariaInvalid={invalid}
          items={[
            { value: 'design', label: 'Design' },
            { value: 'engineering', label: 'Engineering', detail: 'Platform & product' },
            { value: 'people', label: 'People' },
          ]}
        />
      </div>
      <div className="insert-field">
        <label htmlFor="start-date">Start date</label>
        <DateField id="start-date" value={date} onChange={setDate} disabled={disabled} aria-invalid={invalid || undefined} />
      </div>
      <div className="insert-field">
        <label htmlFor="manager-search">Manager</label>
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
            inputProps={{
              id: 'manager-search',
              className: 'picker-input',
              disabled,
              'aria-invalid': invalid || undefined,
              placeholder: 'Find a teammate',
            }}
            popupClassName="picker-popup"
            listClassName="picker-list"
            empty="No matching teammates"
          />
        </div>
      </div>
      <div className="insert-field">
        <label htmlFor="note">Note</label>
        <textarea
          className="insert-input"
          id="note"
          rows={3}
          placeholder="Add useful context"
          disabled={disabled}
          aria-invalid={invalid || undefined}
        />
      </div>
    </div>
  );
}
export const Default: StoryObj = { render: () => <Controls /> };
export const Disabled: StoryObj = { render: () => <Controls disabled /> };
export const Invalid: StoryObj = { render: () => <Controls invalid /> };
export const InDialog: StoryObj = {
  render: function DialogControls() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Edit teammate</button>
        {open && (
          <Modal className="confirm" aria-label="Edit teammate" onClose={() => setOpen(false)}>
            <h2>Edit teammate</h2>
            <Controls />
            <div className="confirm-actions">
              <button className="ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button onClick={() => setOpen(false)}>Save changes</button>
            </div>
          </Modal>
        )}
      </>
    );
  },
  /* Opened, because the story is the fields inside a dialog: at rest it drew
   only the button that opens it. */
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Edit teammate' }));
    /* Portalled out of the story's root, so it is found on the document; and
     present rather than visible, since it is still fading in. */
    const dialog = await within(document.body).findByRole('dialog', { name: 'Edit teammate' });
    await expect(dialog).toBeInTheDocument();
    /* One column: every control shares the field column's left edge and width
     (a typeahead once began 16px left and ran wider, since its grid track
     took the box's min-content), and the buttons stand apart. Measured here
     because happy-dom has no layout. */
    const edges = ['#person-name', '.dd-button', '.date-field-input', '.picker', '#note'].map((selector) => {
      const box = dialog.querySelector(selector)!.getBoundingClientRect();
      return { selector, left: box.left, width: box.width };
    });
    for (const edge of edges) {
      await expect(Math.abs(edge.left - edges[0].left), `${edge.selector} left edge`).toBeLessThanOrEqual(1);
      await expect(Math.abs(edge.width - edges[0].width), `${edge.selector} width`).toBeLessThanOrEqual(1);
    }
    const buttons = [...dialog.querySelectorAll('.confirm-actions button')].map((button) => button.getBoundingClientRect());
    await expect(
      Math.max(
        buttons[1].left - buttons[0].right,
        buttons[0].left - buttons[1].right,
        buttons[1].top - buttons[0].bottom,
        buttons[0].top - buttons[1].bottom,
      ),
    ).toBeGreaterThan(0);
  },
};
