import { Section, Specimen } from '../Specimen';

const COLOURS = [
  ['ground', 'The page'],
  ['surface', 'Controls, popups'],
  ['raised', 'Hover, selected'],
  ['line', 'Rules'],
  ['line-control', 'A control’s edge'],
  ['ink', 'Text'],
  ['ink-muted', 'Secondary text'],
  ['accent', 'Primary, focus'],
  ['good', 'Tone'],
  ['warning', 'Tone'],
  ['critical', 'Tone'],
  ['info', 'Tone'],
];

const TYPE = [
  ['display', 'Leads, at a glance'],
  ['title', 'Stonebridge Supply'],
  ['body', 'Net 30, invoiced on the first of the month.'],
  ['caption', 'Updated 4 minutes ago'],
  ['figure', '$112,000.00'],
];

export function Foundations() {
  return (
    <Section
      id="foundations"
      title="Foundations"
      lede="mistri’s vocabulary, said once in light-dark() and handed to UI SDK through its --ui-* names."
    >
      <Specimen name="Colour" wide>
        <ul data-part="swatches">
          {COLOURS.map(([name, role]) => (
            <li key={name}>
              <span data-part="swatch" style={{ background: `var(--m-${name})` }} />
              <code>--m-{name}</code>
              <span>{role}</span>
            </li>
          ))}
        </ul>
      </Specimen>
      <Specimen name="Type" wide>
        <dl data-part="type-scale">
          {TYPE.map(([step, sample]) => (
            <div key={step}>
              <dt>{step}</dt>
              <dd data-step={step}>{sample}</dd>
            </div>
          ))}
        </dl>
      </Specimen>
    </Section>
  );
}
