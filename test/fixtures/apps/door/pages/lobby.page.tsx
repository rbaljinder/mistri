/**
 * A public free-form page with a form of its own: its one command goes through the page's door
 * (`/api/pages/lobby/commands/enrol`) with the page's ticket, and the human check's token the page passes itself —
 * here one the local stand-in takes once, `lobby-person`, where a real page would pass its own widget's. Its select
 * of makes is drawn from the rows served with the command (`choices`), with no read of the page's own.
 */
import type { FormEvent } from 'react';
import { definePage } from '@mistriwork/mistri/page';
import { useState } from '@mistriwork/mistri/ui';

const page = definePage({
  label: 'Lobby',
  description: 'Put your name down for the next color class.',
  public: true,
  reads: ['make'],
  commands: ['enrol'],
  component: Lobby,
});
export default page;

function Lobby() {
  const enrol = page.useCommand('enrol');
  const [said, setSaid] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const make = (enrol.choices('make') ?? []).find((choice) => String(choice.value) === data.get('make'))?.value;
    const outcome = await enrol.run({}, { name: String(data.get('name') ?? ''), make }, { challenge: 'lobby-person' });
    setSaid(outcome.status === 'applied' ? `Enrolled: ${String((outcome.output as { reference?: unknown }).reference)}` : 'Not enrolled');
  }
  return (
    <form onSubmit={submit} aria-label="Enrol">
      <label>
        Your name <input name="name" required />
      </label>
      <label>
        Paint{' '}
        <select name="make" required defaultValue="">
          <option value="" disabled>
            Pick a paint
          </option>
          {(enrol.choices('make') ?? []).map((choice) => (
            <option key={String(choice.value)} value={String(choice.value)}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">Enrol</button>
      <p role="status">{said}</p>
    </form>
  );
}
