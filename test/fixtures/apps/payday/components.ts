import { component, prop } from '@mistriwork/mistri/app';

/* Payday's own components, declared as data: a name and a module path each,
   placed through custom() where a section stands. The module draws with
   @mistriwork/mistri/ui; what it reads is declared where it is placed. */

/** A run's pay periods on a month axis, and the same runs as a list on a phone. */
export const payrollTimeline = component('payroll-timeline', {
  module: './widgets/PayrollTimeline.tsx',
  props: { months: prop.number({ default: 9, min: 1, max: 36 }) },
});
