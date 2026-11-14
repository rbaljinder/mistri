import { ArrowsClockwise, ArrowRight, Plus, UserPlus } from '@phosphor-icons/react';
import { toast } from '@ui-sdk/react/toast';
import { CommandPalette as Palette } from '../src';

/* The gallery's palette: every room to go to and a few things to do, over the library's own. */
const ROOMS: [string, string, string[]?][] = [
  ['today', 'Today'],
  ['homes', 'Homes to let', ['vacant', 'listing']],
  ['rent-roll', 'Rent roll', ['units']],
  ['lease', 'Lease: Alder Court #101'],
  ['residents', 'Residents', ['tenants', 'people']],
  ['applications', 'Applications', ['review', 'queue']],
  ['books', 'Dashboard', ['charts', 'books']],
  ['repairs', 'Repair board', ['maintenance']],
  ['visits', 'Visits', ['calendar']],
  ['settings', 'Settings'],
  ['kit', 'Drop-in'],
  ['components', 'Components'],
];
const DO: [string, string][] = [
  ['new-home', 'New home'],
  ['invite', 'Invite a teammate'],
  ['post-rent', 'Post this month’s rent'],
];
const ICONS = { 'new-home': <Plus />, invite: <UserPlus />, 'post-rent': <ArrowsClockwise /> } as const;

export function CommandPalette() {
  return (
    <Palette
      remember="gallery"
      groups={[
        { label: 'Go to', commands: ROOMS.map(([value, label, keywords]) => ({ value, label, keywords, icon: <ArrowRight /> })) },
        { label: 'Do', commands: DO.map(([value, label]) => ({ value, label, icon: ICONS[value as keyof typeof ICONS] })) },
      ]}
      onAction={(value) => {
        const room = ROOMS.find(([id]) => id === value);
        if (room) window.location.hash = value;
        else toast(`Ran “${DO.find(([id]) => id === value)?.[1] ?? value}”`);
      }}
    />
  );
}
