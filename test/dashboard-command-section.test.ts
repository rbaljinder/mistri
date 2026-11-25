/**
 * A dashboard's button that runs a command (`commandButton('enableTexting', { title, description })`): a switch the
 * owner throws once, which no record carries and no form asks anything for. A field report had it stand in the menu
 * as a form of one box to tick. The command names no record and needs no input; one that asks for something is
 * refused at load, since the button sends nothing ([dashboard-command]).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTestApp } from './support/commandCatalog.js';

const contracts = {
  enableTexting: { input: { note: { type: 'text', optional: true } } },
  sendBlast: { input: { message: { type: 'text' } } },
  closeTicket: { target: 'ticket', input: {} },
};
const app = (section: Record<string, unknown>) =>
  parseTestApp(
    {
      name: 'Desk',
      connection: 'desk',
      resources: { ticket: { access: 'write' } },
      auth: { providers: ['email'], roles: { owner: { read: true, commands: ['enableTexting', 'sendBlast'] } } },
      views: {
        tickets: { kind: 'list', from: 'ticket' },
        settings: { kind: 'dashboard', label: 'Settings', sections: [section] },
      },
      home: 'tickets',
      nav: ['tickets', 'settings'],
    },
    'fixture',
    contracts,
  );
const sections = (parsed: ReturnType<typeof app>) => (parsed.views.settings as { sections: unknown[] }).sections;

test("a command button runs a command that names no record and needs no input, in the dashboard's words", () => {
  assert.deepEqual(
    sections(
      app({
        kind: 'command',
        command: 'enableTexting',
        title: 'Texting',
        description: 'Send reminders by text.',
        label: 'Turn on texting',
        icon: 'bell',
        width: 'half',
      }),
    ),
    [
      {
        kind: 'command',
        command: 'enableTexting',
        title: 'Texting',
        text: 'Send reminders by text.',
        label: 'Turn on texting',
        icon: 'bell',
        width: 'half',
      },
    ],
  );
  assert.deepEqual(sections(app({ kind: 'command', command: 'enableTexting' })), [{ kind: 'command', command: 'enableTexting' }]);
});

test('a command that asks for something, names a record, or is not registered is refused', () => {
  assert.throws(
    () => app({ kind: 'command', command: 'sendBlast' }),
    /runs "sendBlast", which asks for "message": a dashboard's button sends no input.*\[dashboard-command\]/,
  );
  assert.throws(() => app({ kind: 'command', command: 'closeTicket' }), /names "closeTicket", which acts on an existing record/);
  assert.throws(() => app({ kind: 'command', command: 'nope' }), /names the command "nope", which the commands module does not register/);
  assert.throws(() => app({ kind: 'command', command: 'enableTexting', text: 'x' }), /"text", which only a .* carries/);
  assert.throws(() => app({ kind: 'command', command: 'enableTexting', label: 'x'.repeat(61) }), /"label" longer than 60/);
});

test('a reader is served a command button only where granted its command, in the sections and the aside', async () => {
  const { withGrantedCommandSections } = await import('../packages/mistri/src/shared/appPayload.js');
  const button = (command: string) => ({ kind: 'command', command });
  const payload = {
    views: {
      settings: {
        kind: 'dashboard',
        sections: [button('enableTexting'), button('wipe'), { kind: 'note', text: 'Hi' }],
        aside: [button('wipe')],
      },
      tickets: { kind: 'list', from: 'ticket' },
    },
  } as never;
  const served = withGrantedCommandSections(payload, ['enableTexting']) as unknown as {
    views: { settings: { sections: unknown[]; aside: unknown[] }; tickets: unknown };
  };
  assert.deepEqual(served.views.settings.sections, [button('enableTexting'), { kind: 'note', text: 'Hi' }]);
  assert.deepEqual(served.views.settings.aside, []);
  assert.deepEqual(served.views.tickets, { kind: 'list', from: 'ticket' });
  // No commands module, or no grant: no button at all.
  assert.deepEqual((withGrantedCommandSections(payload, undefined) as typeof served).views.settings.sections, [
    { kind: 'note', text: 'Hi' },
  ]);
});
