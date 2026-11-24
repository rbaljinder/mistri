import { expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import type * as PublicBehaviors from '../../../../schema/behaviors.js';
import { BEHAVIORS_EXPORTS, HOST_MODULES, LAZY_HOST_MODULES } from '../../../shared/uiSdk.js';
import * as behaviors from './behaviors.js';

test('the behaviors module exports exactly the names the served module re-exports', () => {
  expect(Object.keys(behaviors).sort()).toEqual([...BEHAVIORS_EXPORTS].sort());
  expect(Object.keys(HOST_MODULES)).toContain('@mistriwork/mistri/behaviors');
  expect(LAZY_HOST_MODULES).toContain('@mistriwork/mistri/behaviors');
});

test('the declared parts are the ones the module hands out', () => {
  /* Each line fails to compile if the declaration (schema/behaviors.d.ts) asks for a prop the part does not take. */
  const sortable: typeof PublicBehaviors.Sortable = behaviors.Sortable;
  const transfer: typeof PublicBehaviors.Transfer = behaviors.Transfer;
  const transferList: typeof PublicBehaviors.TransferList = behaviors.TransferList;
  const days: typeof PublicBehaviors.Days = behaviors.Days;
  const spans: typeof PublicBehaviors.Spans = behaviors.Spans;
  const scrub: typeof PublicBehaviors.Scrub = behaviors.Scrub;
  const pick: typeof PublicBehaviors.Pick = behaviors.Pick;
  const turns: typeof PublicBehaviors.Turns = behaviors.Turns;
  const widths: typeof PublicBehaviors.Widths = behaviors.Widths;
  const editable: typeof PublicBehaviors.Editable = behaviors.Editable;
  expect(
    [sortable, transfer, transferList, days, spans, scrub, pick, turns, widths, editable].every((part) => typeof part === 'function'),
  ).toBe(true);
  const weeks: typeof PublicBehaviors.weeksOf = behaviors.weeksOf;
  expect(weeks('2026-11', 1)[0]?.[0]).toBe('2026-10-26');
});

test('a component built on the public parts alone: a list the reader orders, heard in this package’s words', () => {
  const heard: Array<{ order: string[]; reason: string; source: string }> = [];
  function Order() {
    const [order, setOrder] = useState(['first', 'second', 'third']);
    return (
      <behaviors.Sortable
        value={order}
        onValueChange={(next, details) => {
          heard.push({ order: next, reason: details.reason, source: details.source });
          setOrder(next);
        }}
        aria-label="Steps"
      >
        {(key) => (
          <behaviors.SortableItem key={key} value={key}>
            {key}
          </behaviors.SortableItem>
        )}
      </behaviors.Sortable>
    );
  }
  const { container } = render(<Order />);
  const first = container.querySelector<HTMLElement>('[data-slot="sortable-item"]')!;
  first.focus();
  const press = (key: string) => first.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press(' ');
  press('ArrowDown');
  press(' ');
  expect(heard).toEqual([{ order: ['second', 'first', 'third'], reason: 'move-key', source: 'keyboard' }]);
  cleanup();
});
