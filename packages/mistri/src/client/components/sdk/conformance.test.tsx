/**
 * What every custom page and component is held to, drawn through the page entry and `ui/testing` the way an author
 * draws one: a layer inside a dialog hands focus back where it came from, each slot is named, a phone-width section
 * is compact, a popup lands beside its trigger under the density zoom, two looks and dark mode reach the same tree,
 * and there is one React. Then the fixtures an author needs to prove the states a field report keeps meeting: a
 * refresh read again, access lost mid-session, a command whose result is not known, a form resumed from its draft.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { afterEach, describe, expect, test } from 'vitest';
import * as react from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { refreshViewportScale } from '@mistriwork/ui/internal/ruler.js';
import { React, useCommand, useLook, useSectionSize, useState } from './index.js';
import type { UiCommandOutcome, UiCommandReview } from './context.js';
import { definePage, List, Modal, Popover, TextField, Tooltip } from './page.js';
import { fixtures, renderPage, renderSection } from './testing.js';

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('zoom');
  refreshViewportScale();
});

const SIGNED_IN = { signedIn: true, account: 'a' };

describe('overlays', () => {
  function Desk() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Edit visit</button>
        {open ? (
          <Modal onClose={() => setOpen(false)}>
            <h2>Visit</h2>
            <Popover trigger={<button type="button">Why</button>} ariaLabel="Why this visit">
              <button type="button">Got it</button>
            </Popover>
          </Modal>
        ) : null}
      </>
    );
  }

  test('a layer inside a dialog is drawn in it, and each layer hands focus back to what opened it', async () => {
    renderSection(Desk, { component: { id: 'desk' } });
    const user = userEvent.setup();
    const opener = await screen.findByRole('button', { name: 'Edit visit' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Visit' });
    const why = await screen.findByRole('button', { name: 'Why' });
    await user.click(why);
    const popover = await screen.findByRole('dialog', { name: 'Why this visit' });
    /* Drawn inside the dialog, so the dialog's focus trap and stacking hold it rather than a sibling on the body. */
    expect(dialog.contains(popover)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Why this visit' })).toBeNull());
    await waitFor(() => expect(why).toHaveFocus());
    expect(screen.getByRole('dialog', { name: 'Visit' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  test('a popup is placed on the zoom-aware ruler: under a root zoom it lands beside its trigger, not a room away', async () => {
    document.documentElement.style.setProperty('zoom', '2');
    refreshViewportScale();
    function Help() {
      return (
        <Popover trigger={<button type="button">Help</button>} ariaLabel="Help">
          Hours are in your time zone.
        </Popover>
      );
    }
    renderSection(Help, { component: { id: 'help' } });
    const trigger = await screen.findByRole('button', { name: 'Help' });
    /* Screen pixels, as getBoundingClientRect answers under a zoom of 2: the layout box is half of each. */
    trigger.getBoundingClientRect = () =>
      ({ x: 200, y: 400, top: 400, left: 200, right: 300, bottom: 440, width: 100, height: 40, toJSON: () => ({}) }) as DOMRect;
    fireEvent.click(trigger);
    const positioner = (await screen.findByRole('dialog', { name: 'Help' })).parentElement!;
    await waitFor(() => expect(positioner.style.getPropertyValue('--anchor-width')).toBe('50px'));
    expect(positioner.style.getPropertyValue('--anchor-height')).toBe('20px');
    expect(positioner.style.position).toBe('fixed');
  });
});

describe('slots, widths and looks', () => {
  test('each slot is named: a dialog by its heading or its label, a field by its label, a popover by what it is for', async () => {
    function Amount() {
      const [amount, setAmount] = useState('');
      return <TextField label="Amount" hint="In dollars." value={amount} onChange={setAmount} />;
    }
    renderSection(Amount, { component: { id: 'amount' } });
    expect(await screen.findByRole('textbox', { name: 'Amount' })).toHaveAccessibleDescription('In dollars.');
    function Unheaded() {
      return (
        <Modal onClose={() => {}} ariaLabel="Adjust balance">
          <p>No heading here.</p>
        </Modal>
      );
    }
    renderSection(Unheaded, { component: { id: 'unheaded' } });
    expect(await screen.findByRole('dialog', { name: 'Adjust balance' })).toBeInTheDocument();
  });

  test('a section 320 pixels wide is compact, as on a phone, and one at a desk is not', async () => {
    function Size() {
      const size = useSectionSize();
      return <p>{`${size.width} ${size.compact ? 'compact' : 'roomy'}`}</p>;
    }
    renderSection(Size, { component: { id: 'size' } }, { width: 320 });
    expect(await screen.findByText('320 compact')).toBeInTheDocument();
    renderSection(Size, { component: { id: 'size' } }, { width: 960 });
    expect(await screen.findByText('960 roomy')).toBeInTheDocument();
  });

  test('two looks and dark mode reach the same tree: the look is the stylesheet’s, never a color written inline', async () => {
    function Card() {
      const look = useLook();
      return (
        <section>
          <p>{`${look.look} ${look.mode}`}</p>
          <TextField label="Name" value="Ana" onChange={() => {}} />
        </section>
      );
    }
    const drawn: string[] = [];
    for (const [look, mode] of [
      ['workshop', 'light'],
      ['mono', 'dark'],
    ] as const) {
      const view = renderSection(Card, { component: { id: 'card' } }, { look, mode });
      expect(await screen.findByText(`${look} ${mode}`)).toBeInTheDocument();
      expect(document.documentElement.dataset).toMatchObject({ visualTheme: look, theme: mode });
      for (const element of view.container.querySelectorAll<HTMLElement>('[style]')) {
        expect(element.getAttribute('style')).not.toMatch(/color|background|#[0-9a-f]{3}|rgb/i);
      }
      /* The ids are useId's, one per drawing; the rest of the tree is what both looks are given. */
      drawn.push(view.container.innerHTML.replace(`${look} ${mode}`, '').replace(/_r_[a-z0-9]+_/g, 'id'));
    }
    expect(drawn[0]).toBe(drawn[1]);
  });

  test('useLook exposes the preset a tenant started from, not only the tenant theme id', async () => {
    function Preset() {
      return <p>{`preset ${useLook().preset}`}</p>;
    }
    renderSection(Preset, { component: { id: 'preset' } }, { preset: 'sage' });
    expect(await screen.findByText('preset sage')).toBeInTheDocument();
  });

  test('there is one React: the one the entry hands out, which the kit’s controls and a page’s hooks share', async () => {
    expect(React).toBe(react);
    const kit = JSON.parse(readFileSync(join(cwd(), 'packages/ui/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    /* A peer, never a dependency: a second copy would give the kit's hooks a dispatcher the page's tree never set. */
    expect(kit.peerDependencies?.react).toBeTruthy();
    expect(kit.dependencies?.react).toBeUndefined();
    function Both() {
      const [open, setOpen] = useState(false);
      return (
        <Tooltip trigger={<button type="button">Due</button>} open={open} onOpenChange={setOpen}>
          The day it is owed.
        </Tooltip>
      );
    }
    renderSection(Both, { component: { id: 'both' } });
    const due = await screen.findByRole('button', { name: 'Due' });
    act(() => due.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('The day it is owed.');
    expect(due).toHaveAccessibleDescription('The day it is owed.');
  });
});

describe('the states a page meets, as fixtures', () => {
  const BOOKINGS = fixtures({
    booking: [
      { id: 1, guest_name: 'Morgan Lee', status: 'booked' },
      { id: 2, guest_name: 'Ana Ruiz', status: 'booked' },
    ],
  });
  const desk = definePage({
    label: 'Desk',
    reads: ['booking'],
    component: () => (
      <List from="booking" show={['guest_name']} sort="id" empty="Nobody booked.">
        {(row) => <span>{`${row.guest_name}`}</span>}
      </List>
    ),
  });

  test('a refresh reads the server as it is now, and access lost mid-session keeps what was read without pretending it is current', async () => {
    const view = renderPage(desk, { data: BOOKINGS });
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    await view.refresh({ data: { booking: [{ id: 3, guest_name: 'Kai Moss', status: 'booked' }] } });
    expect(await screen.findByText('Kai Moss')).toBeInTheDocument();
    expect(screen.queryByText('Ana Ruiz')).toBeNull();
    await view.refresh({ refused: { booking: 403 } });
    /* Never "Nobody booked.": a read the reader lost is not an empty one. */
    expect(screen.queryByText('Nobody booked.')).toBeNull();
  });

  test('a command whose result is not known says so, and checking again settles it', async () => {
    let checks = 0;
    const outcome: UiCommandOutcome = {
      status: 'unknown',
      message: 'The payment may have gone through.',
      check: async () => {
        checks += 1;
        return { status: 'applied', output: { receipt: 'R-7' } };
      },
    };
    function Settle() {
      const settle = useCommand('settle');
      const [said, setSaid] = useState<UiCommandOutcome | null>(null);
      return (
        <>
          <button onClick={() => void settle.run({ id: 1 }).then(setSaid)}>Settle</button>
          {said?.status === 'unknown' ? (
            <>
              <p>{said.message}</p>
              <button onClick={() => void said.check().then(setSaid)}>Check again</button>
            </>
          ) : null}
          {said?.status === 'applied' ? <p>Settled.</p> : null}
        </>
      );
    }
    const view = renderSection(
      Settle,
      { component: { id: 'settle' } },
      { viewer: SIGNED_IN, commands: { settle: { label: 'Settle', outcome } } },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Settle' }));
    expect(await screen.findByText('The payment may have gone through.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Settled.')).toBeInTheDocument();
    expect(checks).toBe(1);
    expect(view.commands).toHaveLength(1);
  });

  test('a review the record moved past is refused stale and shown again, never run over what nobody saw', async () => {
    function Approve() {
      const approve = useCommand('approve');
      const [review, setReview] = useState<UiCommandReview | null>(null);
      const [said, setSaid] = useState<UiCommandOutcome | null>(null);
      return (
        <>
          <button onClick={() => void approve.prepare({ id: 1 }).then((got) => 'token' in got && setReview(got))}>Review</button>
          {review ? <p>{approve.reviewFresh ? 'As reviewed.' : 'Changed since.'}</p> : null}
          {review ? <button onClick={() => void approve.run({ id: 1 }, review.values, { review }).then(setSaid)}>Approve</button> : null}
          {said?.status === 'refused' && said.code === 'stale' ? <p>Review it again.</p> : null}
        </>
      );
    }
    const view = renderSection(
      Approve,
      { component: { id: 'approve' } },
      { viewer: SIGNED_IN, data: BOOKINGS, commands: { approve: { label: 'Approve', resource: 'booking' } } },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText('As reviewed.')).toBeInTheDocument();
    await view.refresh({ data: { booking: [{ id: 1, guest_name: 'Morgan Lee', status: 'cancelled' }] } });
    expect(await screen.findByText('Changed since.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Review it again.')).toBeInTheDocument();
    expect(view.commands).toHaveLength(0);
  });

  test('a form resumed from its draft is read as the form resumes it', async () => {
    const intake = definePage({
      label: 'Intake',
      reads: [],
      forms: ['enroll'],
      component: () => {
        const enroll = intake.useForm('enroll');
        if (enroll.isPending) return null;
        return <p>{enroll.dirty ? `Continue at ${enroll.step}, ${enroll.saved.length} saved` : 'Start'}</p>;
      },
    });
    const steps = [
      { id: 'you', label: 'You' },
      { id: 'cover', label: 'Cover' },
    ];
    renderPage(intake, { viewer: SIGNED_IN, forms: { enroll: { steps, draft: { saved: ['you'], step: 'cover', expiresAt: null } } } });
    expect(await screen.findByText('Continue at cover, 1 saved')).toBeInTheDocument();
  });
});
