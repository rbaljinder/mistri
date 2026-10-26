import { expect, test } from 'vitest';
import { commandsForMode, type MenuScope } from './menuScope.js';

const commands: { label: string; scope?: MenuScope }[] = [
  { label: 'Preferences' },
  { label: 'App definition', scope: 'workbench' },
  { label: 'SQL', scope: 'workbench' },
  { label: 'App action', scope: 'app' },
];

test('app mode offers shared and app commands, without database tools', () => {
  expect(commandsForMode(commands, 'app').map((item) => item.label)).toEqual(['Preferences', 'App action']);
});

test('workbench retains shared and database commands without altering registration order or items', () => {
  const result = commandsForMode(commands, 'workbench');
  expect(result.map((item) => item.label)).toEqual(['Preferences', 'App definition', 'SQL']);
  expect(result[0]).toBe(commands[0]);
  expect(commands).toHaveLength(4);
  expect(commandsForMode(commands, 'app')).toHaveLength(2);
});
