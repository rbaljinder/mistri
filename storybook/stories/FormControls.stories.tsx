import { useState } from 'react';
import '../../packages/kit/src/client/formControls.css';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChoiceCards, Checkbox, Consent, YesNo } from '@mistriwork/ui/Choices.js';
import { ActionBar, Columns, ProgressBar, ReviewList, StepHeader } from '@mistriwork/ui/FormParts.js';
import { SensitiveField } from '@mistriwork/ui/SensitiveField.js';
import { MultiSelect, Select } from '@mistriwork/ui/Select.js';
import { Slider } from '@mistriwork/ui/Slider.js';
import { FileField } from '@mistriwork/ui/FileField.js';
import { MaskedField, MoneyField, TextField } from '@mistriwork/ui/TextField.js';
import { masks } from '@mistriwork/ui';

/* The form controls (Preview): props only, so each story is the control drawn with its states in one column, which the
   visual matrix then sees in every look. Words are written here because the controls hold none. */
const meta = { title: 'Form controls', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;

const column = { display: 'grid', gap: 'var(--field-gap)', maxWidth: 420 } as const;
const MAKES = ['Acura', 'Alfa Romeo', 'Audi', 'BMW', 'Buick'].map((label) => ({ value: label.toLowerCase(), label }));
const TIP = { text: 'We use this to size an offer.', label: 'More information' };

function Boxes() {
  const [name, setName] = useState('Maya');
  const [phone, setPhone] = useState('6786786781');
  const [born, setBorn] = useState('');
  const [pay, setPay] = useState('2500');
  const [ssn, setSsn] = useState('123456789');
  const [file, setFile] = useState<File | null>(null);
  return (
    <div style={column}>
      <TextField label="First name" value={name} onValueChange={setName} valid={name.length > 1} tip={TIP} />
      <TextField label="Employer" value="" onValueChange={() => {}} optional="(optional)" hint="Leave it out if self-employed." />
      <TextField label="Email" value="maya@" onValueChange={() => {}} valid={false} problem="Enter an email like name@example.com." />
      <Columns cols="1fr 1.4fr">
        <MaskedField label="Phone" mask={masks.phone} value={phone} onValueChange={setPhone} valid={phone.length === 10} />
        <MaskedField label="Born" mask={masks.date} value={born} onValueChange={setBorn} />
      </Columns>
      <MoneyField label="Monthly income" value={pay} onValueChange={setPay} />
      <SensitiveField
        label="Social Security number"
        mask={masks.ssn}
        value={ssn}
        onValueChange={setSsn}
        showLabel="Show"
        hideLabel="Hide"
        note="Stored securely."
        valid={ssn.length === 9}
      />
      <TextField label="Read only" value="Fixed" onValueChange={() => {}} readOnly />
      <FileField
        label="Contacts file"
        hint="A CSV, read here before anything is sent."
        accept=".csv,text/csv"
        value={file}
        onValueChange={setFile}
      />
      <FileField label="With a problem" value={null} onValueChange={() => {}} problem="Choose a file." />
      <FileField label="Disabled" value={null} onValueChange={() => {}} disabled />
    </div>
  );
}
export const Boxes_: StoryObj = { name: 'Boxes', render: () => <Boxes /> };

function Lists() {
  const [one, setOne] = useState('');
  const [many, setMany] = useState<string[]>(['acura', 'alfa romeo']);
  return (
    <div style={column}>
      <Select label="Make" options={MAKES} value={one} onValueChange={setOne} placeholder="Choose" />
      <MultiSelect label="Makes you like" options={MAKES} value={many} onValueChange={setMany} placeholder="Choose" />
      <Select label="With a problem" options={MAKES} value="" onValueChange={() => {}} placeholder="Choose" problem="Choose a make." />
    </div>
  );
}
export const Lists_: StoryObj = { name: 'Lists', render: () => <Lists /> };

function Choices() {
  const [own, setOwn] = useState<'yes' | 'no' | ''>('');
  const [one, setOne] = useState<string[]>(['car']);
  const [many, setMany] = useState<string[]>(['car', 'truck']);
  const [agree, setAgree] = useState(false);
  const [budget, setBudget] = useState(400);
  const kinds = [
    { value: 'car', label: 'Car' },
    { value: 'truck', label: 'Truck' },
    { value: 'none', label: 'None of these' },
  ];
  return (
    <div style={column}>
      <YesNo label="Do you own a home?" value={own} onValueChange={setOwn} yes="Yes" no="No" />
      <ChoiceCards label="Vehicle" options={kinds} value={one} onValueChange={setOne} />
      <ChoiceCards label="Vehicles" multiple exclusive="none" options={kinds} value={many} onValueChange={setMany} />
      <Checkbox label="Email me updates" checked={agree} onCheckedChange={setAgree} />
      <Consent
        label="I agree to the terms and the privacy notice, and I understand how my answers are used."
        checked={agree}
        onCheckedChange={setAgree}
      />
      <Slider label="Monthly budget" min={150} max={1000} step={10} value={budget} onValueChange={setBudget} formatValue={(n) => `$${n}`} />
    </div>
  );
}
export const Choices_: StoryObj = { name: 'Choices', render: () => <Choices /> };

export const Chrome: StoryObj = {
  render: () => (
    <div style={column}>
      <ProgressBar value={3} max={12} label="Step 3 of 12" />
      <StepHeader title="Next, your income." lead="This helps us pre-qualify you for vehicles in your budget." />
      <ReviewList label="Your answers">
        <TextField label="Employer" value="Northwind" onValueChange={() => {}} readOnly />
      </ReviewList>
      <ActionBar back={{ label: 'Back', onClick: () => {} }} primary={{ label: 'Continue', onClick: () => {} }} />
    </div>
  ),
};
