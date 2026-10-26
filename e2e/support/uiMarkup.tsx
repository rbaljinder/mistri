/**
 * @mistriwork/ui's primitives rendered to markup, printed: the page e2e/ui-standalone.spec.ts serves with ui's stylesheet
 * alone. Rendered here, under tsx, because Playwright's own JSX transform makes its component-testing nodes, not
 * React's. The root tsconfig, which says `react-jsx`, does not include e2e/, so the pragma says it here.
 */
/** @jsxRuntime automatic */
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../../packages/ui/src/Button.tsx';
import { DateField, type DateFieldWords } from '../../packages/ui/src/DateField.tsx';
import { Field } from '../../packages/ui/src/Field.tsx';
import { Icon, registerIcons } from '../../packages/ui/src/Icon.tsx';

const words: DateFieldWords = {
  dateTimePattern: 'YYYY-MM-DD HH:MM',
  enterDateAndTime: 'Enter a date and time.',
  enterDate: (format) => `Enter a date as ${format}.`,
  dateAndTimeFormat: 'Date and time.',
  dateFormat: (format) => `Date format: ${format}.`,
  openWithKeys: 'Alt and Down arrow opens the calendar.',
  chooseDate: (label) => `Choose date${label ? ` for ${label}` : ''}`,
  calendar: (label) => `Calendar${label ? ` for ${label}` : ''}`,
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  clear: 'Clear',
  today: 'Today',
};

registerIcons({ dot: [['M0 0h256v256H0z'], ['M0 0h256v256H0z']] });
process.stdout.write(
  renderToStaticMarkup(
    <main>
      <Button intent="primary">Save</Button>
      <Button intent="secondary" size="compact" data-host="">
        Cancel
      </Button>
      <Field label="Name" hint="As it is written.">
        {(control) => <input {...control} className="field-control" />}
      </Field>
      <Icon name="dot" />
      <DateField
        id="due"
        aria-label="Due"
        value="2026-09-13"
        onChange={() => {}}
        locale="en-US"
        words={words}
        calendarIcon={<Icon name="dot" />}
      />
    </main>,
  ),
);
