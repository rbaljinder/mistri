import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { builtInInput } from '../../packages/mistri/src/client/components/builtInInputs.js';
import { Field } from '@mistriwork/ui/Field.js';
import { applicationFixture } from '../mocks/core.js';

/* The platform's own inputs for a display rule: the control a column is edited in once its rule says what the value
   is. In the App they are a part fetched through the same slot an App's own input takes; here each is drawn directly,
   inside the Field every form wraps a control in. The inputs read their rule (a rating's length, a slider's range)
   from the App's payload, so the fixture carries one. */
const meta = {
  title: 'Forms/Built-in inputs',
  parameters: { layout: 'padded' },
  beforeEach: async () => {
    await applicationFixture({
      tables: [],
      app: {
        id: 'projects',
        name: 'Projects',
        ui: {},
        nav: [],
        views: {},
        resources: {
          project: {
            table: 'project',
            display: {
              health: { format: 'rating', outOf: 5 },
              term: { slider: { min: 12, max: 84, step: 12 } },
              brand: { format: 'color' },
              opens: { format: 'time' },
              renews: { format: 'month' },
              model: { format: 'year' },
              settings: { format: 'json' },
              upc: { scan: true },
              signed: { signature: { table: 'signature', key: 'id' } },
            },
          },
        },
      },
    });
  },
} satisfies Meta;
export default meta;

type Value = string | number | boolean | null;

/* One field with the state a form keeps for it. */
function Row({
  input,
  column,
  label,
  hint,
  initial,
  disabled = false,
}: {
  input: string;
  column: string;
  label: string;
  hint?: string;
  initial: Value;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<Value>(initial);
  const Input = builtInInput(input)!;
  return (
    <Field label={label} hint={hint}>
      {(control) => (
        <Input
          value={value}
          onChange={setValue}
          id={control.id}
          describedBy={control['aria-describedby']}
          invalid={false}
          disabled={disabled}
          required={false}
          label={label}
          field={{ name: column, resource: 'project' }}
        />
      )}
    </Field>
  );
}

const column = { display: 'grid', gap: 18, maxWidth: 460 } as const;

/* Stars as a radio group of the rule's length: a second click on the one picked clears it. */
export const Rating: StoryObj = {
  render: () => (
    <div style={column}>
      <Row input="rating" column="health" label="Customer health" hint="Pick a star again to clear it." initial={4} />
      <Row input="rating" column="health" label="Not rated yet" initial={null} />
      <Row input="rating" column="health" label="Locked" initial={3} disabled />
    </div>
  ),
};

/* A number along the rule's range and step, its figure beside it. */
export const Slider: StoryObj = {
  render: () => (
    <div style={column}>
      <Row input="slider" column="term" label="Contract term (months)" initial={36} />
      <Row input="slider" column="term" label="Locked" initial={60} disabled />
    </div>
  ),
};

/* The browser's own pickers, trimmed to what each shows, and the color's picker with its code beside it. */
export const ColorTimeMonthYear: StoryObj = {
  render: () => (
    <div style={column}>
      <Row input="color" column="brand" label="Brand color" initial="#1d4ed8" />
      <Row input="time" column="opens" label="Opens at" initial="08:30:00" />
      <Row input="month" column="renews" label="Renews in" initial="2027-03" />
      <Row input="year" column="model" label="Model year" initial={2024} />
    </div>
  ),
};

/* A monospaced box that says where the text stops being JSON and formats it on request. */
export const JsonEditor: StoryObj = {
  render: () => (
    <div style={column}>
      <Row
        input="json"
        column="settings"
        label="Integration settings"
        initial={'{"provider":"CDK","sync":{"inventory":true,"pricing":false}}'}
      />
      <Row input="json" column="settings" label="Not valid yet" initial={'{"provider": "CDK", "sync": '} />
    </div>
  ),
};

/* The box always takes typing, for a scanner gun or the keyboard; Scan appears only where the browser reads codes,
   which the story says it does so the button is seen. */
export const Scan: StoryObj = {
  beforeEach: () => {
    const had = Object.getOwnPropertyDescriptor(window, 'BarcodeDetector');
    Object.defineProperty(window, 'BarcodeDetector', {
      configurable: true,
      writable: true,
      value: class {
        detect = async () => [];
      },
    });
    return () => {
      if (had) Object.defineProperty(window, 'BarcodeDetector', had);
      else delete (window as unknown as Record<string, unknown>).BarcodeDetector;
    };
  },
  render: () => (
    <div style={column}>
      <Row input="scan" column="upc" label="UPC" hint="Type it, or scan the barcode." initial="036000291452" />
      <Row input="scan" column="upc" label="Empty" initial={null} />
    </div>
  ),
};

/* A pad to draw on, or a name to type; kept as a picture. The pad is white in every look so the kept picture reads
   wherever it is shown. */
export const SignaturePad: StoryObj = {
  render: () => (
    <div style={column}>
      <Row input="signature" column="signed" label="Proof of delivery" hint="Draw with a finger, a stylus or the mouse." initial={null} />
    </div>
  ),
};
