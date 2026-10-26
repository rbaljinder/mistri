// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';
export const teamRoles = [
  { value: 'owner', label: 'Owner' },
  { value: 'sales_manager', label: 'Sales manager' },
  { value: 'finance_manager', label: 'Finance manager' },
  { value: 'salesperson', label: 'Salesperson' },
  { value: 'viewer', label: 'Viewer' },
] as const;
export const addTeamMemberInput = {
  name: field.text({ label: 'Full name', max: 120 }),
  email: field.email({ label: 'Work email', help: 'Their invitation to the leads desk goes here. One person, one address.' }),
  phone: field.phone({ label: 'Mobile', optional: true }),
  role: field.choice(teamRoles, {
    help: 'Owners manage the team. Sales managers may add salespeople and viewers.',
  }),
};

export const updateDealerContactInput = {
  phone: field.phone({ label: 'Main phone' }),
  email: field.email({ label: 'Main email', help: 'Where Keystone sends funding notices and statements.' }),
};

export const changeTeamRoleInput = { role: field.choice(teamRoles, { label: 'New role' }) };

export const deactivateTeamMemberInput = {};
