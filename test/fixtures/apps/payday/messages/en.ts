import { defineMessages } from '@mistriwork/mistri/app';

/* Payday's own words, in its own language (ui.locale 'en-US'): the source every other catalog translates. A caption
   names one with msg('people.salary'); the server says it in each reader's language. */
const en = defineMessages('en', {
  'people.people': 'People',
  'people.name': 'Name',
  'people.email': 'Email',
  'people.team': 'Department',
  'people.jobTitle': 'Job title',
  'people.location': 'Location',
  'people.status': 'Status',
  'people.started': 'Start date',
  'people.payType': 'Pay type',
  'people.salary': 'Salary',
  'people.payRate': 'Pay rate',
  'people.manager': 'Manager',
  'people.basicDetails': 'Basic details',
  'people.overview': 'Overview',
  'people.employment': 'Employment',
  'people.jobDetails': 'Job details',
  'people.jobPay': 'Job & pay',
  'people.annualSalary': 'Annual salary',
  'people.hourlyPay': 'Hourly pay',
  'people.pay': 'Pay',
  'people.payHistory': 'Pay history',
  'people.timeOff': 'Time off',
  'people.balances': 'Balances',
  'people.requests': 'Requests',
  'people.benefits': 'Benefits',
  'people.documents': 'Documents',
  'people.onboarding': 'Onboarding',
  'people.directReports': 'Direct reports',
  'people.task': 'Task',
  'people.teammate': 'Teammate',
  'people.onboardingEmpty': 'No onboarding tasks yet',
  'people.onboardingHint': 'Assigned tasks and their progress will appear here.',
  'people.viewOnboarding': 'View onboarding',
  'people.toDo': 'To do',
  'people.completed': 'Completed',
  'people.allTasks': 'All tasks',
});
export default en;

/* msg() takes only these keys. */
declare module '@mistriwork/mistri/app' {
  interface AppMessages extends Record<keyof typeof en.entries, string> {}
}
