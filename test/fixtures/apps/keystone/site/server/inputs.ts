// The shared form fields with placement-neutral stock and consent presentation.
import { field } from '@mistriwork/mistri/commands';
import { applyForFinancingInput as financing, askAboutVehicleInput as question, requestTestDriveInput as testDrive } from '../inputs.ts';

const stock = (optional: boolean, empty = 'Leave it empty for a general question.') =>
  field.text({
    label: 'Stock number',
    max: 8,
    case: 'upper',
    pattern: /[A-Z]{1,4}\d{4}/,
    optional,
    message: 'A stock number such as AB1001.',
    help: `From a car’s page it is filled in for you.${optional ? ` ${empty}` : ''}`,
  });

export const askAboutVehicleInput = { ...question, stock_number: stock(true) };
export const requestTestDriveInput = { ...testDrive, stock_number: stock(false) };
export const applyForFinancingInput = {
  ...financing,
  stock_number: stock(true, 'Leave it empty to learn your budget before you choose.'),
  consent: field.bool({
    label: 'The details I gave are true, and this dealership may send them to Keystone Auto Finance for a credit decision',
  }),
};
