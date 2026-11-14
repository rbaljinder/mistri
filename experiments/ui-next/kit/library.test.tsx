import { act, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { CheckCardsField, YesNoField } from '../src/choices';
import { type ChecklistItem, Checklist, PickList } from '../src/composed';
import { Tabs } from '../src/display';
import { CheckField, SwitchField, TextField } from '../src/fields';
import { FormProblems, useForm } from '../src/Form';
import { caretAfter, masks, shaped } from '../src/masks';
import { Pager } from '../src/Pager';
import { SchemaForm } from '../src/SchemaForm';
import { resetWords, setWords } from '../src/words';
import { all, clear, draw, focus, key, labelled } from './testing';

afterEach(clear);

const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

/* ---------- masks: what is kept, what is shown, and where the caret goes ---------- */

test('a shape draws its punctuation only once a digit stands after it', () => {
  const phone = masks.phone;
  expect(phone.format('')).toBe('');
  expect(phone.format('7')).toBe('(7');
  expect(phone.format('720')).toBe('(720');
  expect(phone.format('7205')).toBe('(720) 5');
  expect(phone.format('7205550142')).toBe('(720) 555-0142');
  expect(phone.parse('(720) 555-0142 ext 9')).toBe('7205550142');
  expect(phone.length).toBe(10);
});

test('a mask of one’s own is a shape', () => {
  const plate = shaped('##-####');
  expect(plate.format('123456')).toBe('12-3456');
  expect(plate.parse('12-34567')).toBe('123456');
});

test('money groups its digits and drops a leading zero', () => {
  const money = masks.money('$');
  expect(money.format(money.parse('02500'))).toBe('$2,500');
  expect(money.format('')).toBe('');
});

test('the caret stands just past the digit it was typed after', () => {
  expect(caretAfter('(720) 555-0142', 0)).toBe(0);
  expect(caretAfter('(720) 555-0142', 3)).toBe(4);
  expect(caretAfter('(720) 555-0142', 4)).toBe(7);
  expect(caretAfter('(720) 555-0142', 10)).toBe(14);
  expect(caretAfter('(720', 9)).toBe(4);
});

/* ---------- answers that are a choice ---------- */

test('a yes or a no starts unanswered, and says which was pressed', () => {
  const heard: boolean[] = [];
  function Pets() {
    const [answer, setAnswer] = useState<boolean | null>(null);
    return (
      <YesNoField
        label="Any pets?"
        value={answer}
        onValueChange={(next) => {
          heard.push(next);
          setAnswer(next);
        }}
      />
    );
  }
  draw(<Pets />);
  const radios = all('radio');
  expect(radios.length).toBe(2);
  expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true').length).toBe(0);
  press(radios[1]!);
  expect(heard).toEqual([false]);
  expect(all('radio')[1]?.getAttribute('aria-checked')).toBe('true');
});

test('check cards count down to their limit, and at it the rest stand back', () => {
  const heard: string[][] = [];
  draw(
    <CheckCardsField
      label="Included"
      max={2}
      hint="Up to two."
      options={[
        { value: 'water', label: 'Water' },
        { value: 'heat', label: 'Heating' },
        { value: 'parking', label: 'Parking' },
      ]}
      defaultValue={['water']}
      onValueChange={(next) => heard.push(next)}
    />,
  );
  expect(document.querySelector('[data-slot="field-count"]')?.textContent).toBe('1 more may be chosen');
  press(all('checkbox')[1]!);
  expect(heard).toEqual([['water', 'heat']]);
  expect(document.querySelector('[data-slot="field-count"]')?.textContent).toBe('All 2 chosen');
  const parking = all('checkbox')[2]!;
  expect(
    parking.getAttribute('aria-disabled') === 'true' || parking.hasAttribute('disabled') || parking.hasAttribute('data-disabled'),
  ).toBe(true);
  // One given back, the rest may be chosen again.
  press(all('checkbox')[0]!);
  expect(document.querySelector('[data-slot="field-count"]')?.textContent).toBe('1 more may be chosen');
});

test('tabs as data draw a tab each and the first one’s panel', () => {
  draw(
    <Tabs
      label="Books"
      items={[
        { value: 'charges', label: 'Charges', count: 12, content: <p>Twelve charges</p> },
        { value: 'payments', label: 'Payments', content: <p>Nine payments</p> },
      ]}
    />,
  );
  expect(all('tab').map((tab) => tab.textContent)).toEqual(['Charges12', 'Payments']);
  expect(all('tab')[0]?.getAttribute('aria-selected')).toBe('true');
  expect(document.body.textContent).toContain('Twelve charges');
});

/* ---------- composed on the behaviors ---------- */

function Crew({ max }: { max?: number }) {
  const [crew, setCrew] = useState(['sara']);
  return (
    <PickList
      label="Who is on the visit"
      max={max}
      options={[
        { value: 'marta', label: 'Marta' },
        { value: 'jonas', label: 'Jonas' },
        { value: 'sara', label: 'Sara' },
      ]}
      value={crew}
      onValueChange={setCrew}
    />
  );
}
const side = (list: string) =>
  [...document.querySelectorAll(`[data-list="${list}"] [data-slot="pick-list-words"]`)].map((item) => item.textContent);

test('a pick list sends an item across by its arrow, and keeps the order chosen', () => {
  draw(<Crew />);
  expect(side('offered')).toEqual(['Marta', 'Jonas']);
  expect(side('chosen')).toEqual(['Sara']);
  press(labelled('Choose Jonas'));
  press(labelled('Choose Marta'));
  expect(side('chosen')).toEqual(['Sara', 'Jonas', 'Marta']);
  press(labelled('Take Sara out'));
  expect(side('chosen')).toEqual(['Jonas', 'Marta']);
  expect(side('offered')).toEqual(['Sara']);
});

test('a pick list at its limit takes no more, by the arrow or by being carried to', () => {
  draw(<Crew max={1} />);
  expect((labelled('Choose Marta') as HTMLButtonElement).disabled).toBe(true);
  const grip = document.querySelector<HTMLElement>('[aria-label="Carry Marta"]')!;
  focus(grip);
  key(grip, ' ');
  expect(document.querySelector('[data-list="chosen"]')?.hasAttribute('data-refuses')).toBe(true);
  key(document.querySelector<HTMLElement>('[aria-label="Carry Marta"]')!, 'ArrowRight');
  key(document.querySelector<HTMLElement>('[aria-label="Carry Marta"]')!, ' ');
  expect(side('chosen')).toEqual(['Sara']);
});

test('a checklist is ticked and put in order', () => {
  function Steps() {
    const [items, setItems] = useState<ChecklistItem[]>([
      { id: 'keys', label: 'Cut keys' },
      { id: 'meter', label: 'Read the meters' },
      { id: 'clean', label: 'Book the cleaner' },
    ]);
    return <Checklist label="Handover" items={items} onItemsChange={setItems} />;
  }
  draw(<Steps />);
  const rows = () => all('listitem').map((item) => `${item.textContent}${item.hasAttribute('data-done') ? ' ✓' : ''}`);
  press(all('checkbox')[1]!);
  expect(rows()).toEqual(['Cut keys', 'Read the meters ✓', 'Book the cleaner']);
  const grips = () => [...document.querySelectorAll<HTMLElement>('[data-slot="sortable-handle"]')];
  focus(grips()[2]!);
  key(grips()[2]!, ' ');
  key(document.activeElement!, 'ArrowUp');
  key(document.activeElement!, 'ArrowUp');
  key(document.activeElement!, ' ');
  expect(rows()).toEqual(['Book the cleaner', 'Cut keys', 'Read the meters ✓']);
});

/* ---------- a form that holds its answers ---------- */

test('a field handed its value shows it, tells every change, and stands down when disabled', () => {
  function Form() {
    const [name, setName] = useState('Camila');
    const [on, setOn] = useState(false);
    const [locked, setLocked] = useState(false);
    return (
      <>
        <TextField label="Name" required value={name} onValueChange={(next) => setName(String(next))} disabled={locked} />
        <SwitchField label="Furnished" checked={on} onCheckedChange={setOn} disabled={locked} />
        <CheckField label="Lock" checked={locked} onCheckedChange={setLocked} />
        <output>{`${name}|${on}`}</output>
        <button type="button" aria-label="Clear" onClick={() => setName('')} />
      </>
    );
  }
  draw(<Form />);
  const box = document.querySelector<HTMLInputElement>('input[data-slot="input"]')!;
  expect(box.value).toBe('Camila');
  // The mark for a field that must be answered is drawn, and the word for it is there for a screen reader.
  expect(document.querySelector('[data-slot="field-required"]')?.textContent).toBe('*');
  expect(document.querySelector('[data-slot="field-label"]')?.textContent).toContain('(required)');
  press(labelled('Clear'));
  expect(box.value).toBe('');
  press(all('switch')[0]!);
  expect(document.querySelector('output')?.textContent).toBe('|true');
  press(all('checkbox')[0]!);
  expect(box.disabled).toBe(true);
  expect(all('switch')[0]?.getAttribute('aria-disabled') === 'true' || all('switch')[0]?.hasAttribute('disabled')).toBe(true);
});

test('the card that means none unticks the rest, and any other unticks it', () => {
  const heard: string[][] = [];
  draw(
    <CheckCardsField
      label="Included"
      exclusive="none"
      options={[
        { value: 'water', label: 'Water' },
        { value: 'heat', label: 'Heating' },
        { value: 'none', label: 'Nothing' },
      ]}
      defaultValue={['water', 'heat']}
      onValueChange={(next) => heard.push(next)}
    />,
  );
  press(all('checkbox')[2]!);
  expect(heard.at(-1)).toEqual(['none']);
  press(all('checkbox')[0]!);
  expect(heard.at(-1)).toEqual(['water']);
});

test('a field with a limit counts what is typed, and says so to a screen reader only near the limit', () => {
  function Note() {
    const [text, setText] = useState('Ring twice');
    return <TextField label="Note" maxLength={20} value={text} onValueChange={(next) => setText(String(next))} />;
  }
  draw(<Note />);
  const count = () => document.querySelector('[data-slot="field-count"]')!;
  expect(count().querySelector('[aria-hidden]')?.textContent).toBe('10 / 20');
  expect(count().hasAttribute('data-near')).toBe(true);
  expect(count().querySelector('[aria-live]')?.textContent).toBe('10 characters left');
  expect(document.querySelector<HTMLInputElement>('input[data-slot="input"]')?.maxLength).toBe(20);
});

test('a label that is hidden is still the field’s name, and a line is kept for its problem', () => {
  draw(<TextField label="Search homes" labelHidden reserve />);
  expect(document.querySelector('[data-slot="field-label"]')?.hasAttribute('data-hidden')).toBe(true);
  const box = document.querySelector<HTMLInputElement>('input[data-slot="input"]')!;
  expect(document.getElementById(box.getAttribute('aria-labelledby') ?? '')?.textContent).toContain('Search homes');
  expect(document.querySelector('[data-slot="field-reserve"]')).not.toBeNull();
});

/* ---------- the library's own words ---------- */

test('the words the library says on its own account can be given in another language', () => {
  setWords({
    previousPage: 'Página anterior',
    nextPage: 'Página siguiente',
    optional: 'Opcional',
    clearField: (label) => `Borrar ${label}`,
  });
  try {
    draw(
      <>
        <Pager pageCount={5} />
        <TextField label="Referencia" optional clearable defaultValue="LN-1" />
      </>,
    );
    expect(labelled('Página anterior')).not.toBeNull();
    expect(labelled('Página siguiente')).not.toBeNull();
    expect(document.querySelector('[data-slot="field-optional"]')?.textContent).toBe('Opcional');
  } finally {
    resetWords();
  }
});

/* ---------- a form: what goes wrong, and what the reader is told ---------- */

function Signup({ taken, sent }: { taken?: string; sent: (answers: Record<string, string>) => void }) {
  const hold = useForm({
    validate: (said) => ({
      name: said.name?.trim() ? undefined : 'A name is needed.',
      email: said.email?.includes('@') ? undefined : 'That is not an address.',
    }),
    submit: async (said) => {
      if (taken && said.email === taken) return { fields: { email: 'That address is already signed up.' } };
      sent(said);
      return undefined;
    },
  });
  return (
    <form {...hold.form}>
      <FormProblems hold={hold} labels={{ name: 'Name', email: 'Email' }} />
      <TextField label="Name" name="name" error={hold.problem('name')} />
      <TextField label="Email" name="email" error={hold.problem('email')} />
      <button type="submit" aria-label="Send" />
      <output>{hold.busy ? 'busy' : hold.touched ? 'touched' : 'clean'}</output>
    </form>
  );
}
const submit = () => act(() => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
const fill = (name: string, text: string) =>
  act(() => {
    const box = document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });

test('answers are checked before they are sent, and each problem stands on its field and in the summary', async () => {
  const sent: Record<string, string>[] = [];
  draw(<Signup sent={(answers) => sent.push(answers)} />);
  submit();
  await settle();
  expect(sent).toEqual([]);
  expect([...document.querySelectorAll('[data-slot="field-error"]')].map((line) => line.textContent)).toEqual([
    'A name is needed.',
    'That is not an address.',
  ]);
  const summary = document.querySelector('[data-slot="form-problems"]')!;
  expect(summary.getAttribute('role')).toBe('alert');
  expect(summary.textContent).toContain('2 answers need another look.');
  // The keyboard is put on the first field that has a problem.
  expect(document.activeElement).toBe(document.querySelector('input[name="name"]'));
});

test('a problem goes the moment its field is changed, and answers that pass are sent', async () => {
  const sent: Record<string, string>[] = [];
  draw(<Signup sent={(answers) => sent.push(answers)} />);
  submit();
  await settle();
  fill('name', 'Camila');
  expect([...document.querySelectorAll('[data-slot="field-error"]')].map((line) => line.textContent)).toEqual(['That is not an address.']);
  expect(document.querySelector('output')?.textContent).toBe('touched');
  fill('email', 'camila@example.test');
  submit();
  await settle();
  expect(sent).toEqual([{ name: 'Camila', email: 'camila@example.test' }]);
  expect(document.querySelector('[data-slot="form-problems"]')).toBeNull();
  expect(document.querySelector('output')?.textContent).toBe('clean');
});

test('what the taker refuses lands on its field the same way', async () => {
  const sent: Record<string, string>[] = [];
  draw(<Signup taken="camila@example.test" sent={(answers) => sent.push(answers)} />);
  fill('name', 'Camila');
  fill('email', 'camila@example.test');
  submit();
  await settle();
  expect(sent).toEqual([]);
  expect([...document.querySelectorAll('[data-slot="field-error"]')].map((line) => line.textContent)).toEqual([
    'That address is already signed up.',
  ]);
  expect(document.querySelector('[data-slot="form-problems"]')?.textContent).toContain('One answer needs another look.');
});

/* ---------- a form drawn from a description ---------- */

function Apply({ sent, refuse }: { sent: (answers: Record<string, string>) => void; refuse?: boolean }) {
  return (
    <SchemaForm
      label="Apply"
      review
      steps={[
        {
          id: 'you',
          title: 'About you',
          fields: [
            { name: 'name', label: 'Name', kind: 'text', required: true },
            { name: 'phone', label: 'Phone', kind: 'masked', mask: 'phone', initial: '7205550142' },
          ],
        },
        {
          id: 'home',
          title: 'The home',
          fields: [
            { name: 'pets', label: 'Any pets?', kind: 'text', initial: 'no' },
            { name: 'pet_kind', label: 'What kind?', kind: 'text', required: true, when: (answers) => answers.pets === 'yes' },
          ],
        },
      ]}
      submit={(answers) => {
        if (refuse) return { fields: { name: 'That name is already on a lease.' } };
        sent(answers);
        return undefined;
      }}
    />
  );
}
const step = () => document.querySelector('[data-slot="step-header"] h2')?.textContent;
const count = () => document.querySelector('[data-slot="step-count"]')?.textContent;

test('a step is checked when it is left forward, and Back keeps what was answered', async () => {
  draw(<Apply sent={() => {}} />);
  expect(`${count()}: ${step()}`).toBe('Step 1 of 3: About you');
  submit();
  await settle();
  expect(step()).toBe('About you');
  expect([...document.querySelectorAll('[data-slot="field-error"]')].map((line) => line.textContent)).toEqual(['Name is needed.']);
  fill('name', 'Camila');
  submit();
  await settle();
  expect(step()).toBe('The home');
  // Arriving on a step puts the keyboard on its name.
  expect(document.activeElement).toBe(document.querySelector('[data-slot="step-header"] h2'));
  press([...document.querySelectorAll('button')].find((button) => button.textContent === 'Back')!);
  expect(step()).toBe('About you');
  expect(document.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Camila');
});

test('a question that depends on an answer is asked, checked and sent only while that answer stands', async () => {
  const sent: Record<string, string>[] = [];
  draw(<Apply sent={(answers) => sent.push(answers)} />);
  fill('name', 'Camila');
  submit();
  await settle();
  expect(document.querySelector('input[name="pet_kind"]')).toBeNull();
  fill('pets', 'yes');
  expect(document.querySelector('input[name="pet_kind"]')).not.toBeNull();
  submit();
  await settle();
  expect([...document.querySelectorAll('[data-slot="field-error"]')].map((line) => line.textContent)).toEqual(['What kind? is needed.']);
  fill('pet_kind', 'A cat');
  fill('pets', 'no');
  expect(document.querySelector('input[name="pet_kind"]')).toBeNull();
  submit();
  await settle();
  // The review says each answer back the way it was typed, and not the one that is no longer asked.
  expect(step()).toBe('Check your answers');
  const lines = [...document.querySelectorAll('[data-slot="review-list"] > div')].map(
    (line) => `${line.querySelector('dt')?.textContent}: ${line.querySelector('dd')?.textContent}`,
  );
  expect(lines).toEqual(['Name: Camila', 'Phone: (720) 555-0142', 'Any pets?: no']);
  submit();
  await settle();
  expect(sent).toEqual([{ name: 'Camila', phone: '7205550142', pets: 'no' }]);
});

test('what the taker refuses takes the form back to the step it is on', async () => {
  draw(<Apply sent={() => {}} refuse />);
  fill('name', 'Camila');
  submit();
  await settle();
  submit();
  await settle();
  expect(step()).toBe('Check your answers');
  submit();
  await settle();
  expect(step()).toBe('About you');
  expect([...document.querySelectorAll('[data-slot="field-error"]')].map((line) => line.textContent)).toEqual([
    'That name is already on a lease.',
  ]);
});
