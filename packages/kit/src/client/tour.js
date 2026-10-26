/**
 * A short walk around the interface, once.
 *
 * The case for it is narrow and real. Almost everything here is discoverable
 * by clicking, and four things are not: that the bar takes a language rather
 * than SQL, that clicking a row is the whole point rather than a way to see
 * its columns, that editing exists at all behind a switch that says "Read
 * only", and that the thing in the corner is a database picker. Each is one
 * sentence. A tour is worth six sentences and nothing more.
 *
 * What that rules out is most of what tours do. There is no progress bar, no
 * confetti, nothing that has to be dismissed twice, and no stop that says
 * "click here to continue" — the reader is never made to perform the
 * interface to get out of the tour, because a tour that drives is a tour
 * people learn to escape rather than read. Escape ends it, so does Skip, and
 * ending it is remembered.
 *
 * Two things it does that a simpler version would not:
 *
 *   - **A stop whose anchor is not on screen is dropped**, not shown pointing
 *     at nothing. The sidebar collapses, the toolbar sheds buttons at narrow
 *     widths, and a card captioning an empty rectangle is worse than one
 *     fewer stop.
 *
 *   - **One stop has no anchor at all.** The idea that a row is a place you
 *     walk from is the reason this tool exists and it is not a control, so it
 *     is not attached to one. Pinning it to whichever element happened to be
 *     nearby would be inventing a location for an idea.
 *
 * It is remembered in `localStorage`, so it is per browser rather than per
 * connection: it teaches the interface, and the interface does not change
 * when the database does.
 */
import { createElement } from 'react';
import { addMenuItem, menuMode } from './menu.js';
import { mount, unmount } from './components/mount.js';
import { sayUnavailable } from './components/onDemand.js';
import { say } from './copy/workbench/tour.js';
import { portalRoot } from './shellHost.js';

const SEEN = 'mistri.tour.v1';

/**
 * The stops, in the order the eye takes them: where you are, what is here,
 * how to ask, what happens when you click, what it will not do, and where the
 * rest is.
 */
const STOPS = [
  {
    /* Two spellings of one thing, and which is on screen depends on how many
       connections there are: the picker when there is a choice to make, the
       plain label when there is not. A stop that named only one of them was
       silently dropped for everybody with a config file — which is to say for
       everybody the tour is most useful to. */
    anchor: ['#conn-picker', '#db-label'],
    title: say('theDatabase'),
    body: say('clickItToSwitch') + say('screenComesFromWhichever'),
  },
  {
    anchor: '.sidebar',
    title: say('everyTableWithItsSize'),
    body: say('theNumberIsHow'),
  },
  {
    anchor: '#querybar',
    title: say('askInWordsNotSql'),
    /* Set as code rather than run into the sentence. A query in prose is a
       string of ordinary words that happens to be a literal, and the reader
       has to be told which part to type. */
    code: 'customer active = true sort name limit 20',
    body: say('tableFirstThenConditions') + say('grammarOrSqlToSee'),
  },
  {
    /* No anchor: an idea, not a control. */
    anchor: null,
    title: say('aRowIsAPlace'),
    body: say('clickAnyRowAndYouGet') + say('ordersOnACustomer') + say('aTrailBehindYouThatGoes'),
  },
  {
    anchor: '#more-button',
    title: say('readOnlyUntilYouSay'),
    body: say('theWorkbenchStartsRead') + say('toEditThisConnection'),
  },
  {
    anchor: '#search-button',
    title: say('andTheRest'),
    body: say('kJumpsToAny') + say('exportsSavedViewsAndThisTour'),
  },
];

function tourSeen() {
  try {
    return window.localStorage.getItem(SEEN) === 'done';
  } catch {
    /* Private browsing, or storage turned off. Treating that as "already
       seen" is the right way to be wrong: a tour that cannot remember being
       dismissed would open on every single load. */
    return true;
  }
}

function remember() {
  try {
    window.localStorage.setItem(SEEN, 'done');
  } catch {
    /* Nothing to do, and nothing worth saying about it. */
  }
}

let host = null;

function endTour({ remembering = true } = {}) {
  if (remembering) remember();
  if (!host) return;
  unmount(host);
  host.remove();
  host = null;
}

/* The card is fetched the first time the tour starts: most visits are not a first one. */
let starting = false;

/** Start it, or do nothing if there is nothing to show. The card is `components/Tour.tsx`. */
async function startTour({ asked = false } = {}) {
  if (host || starting || menuMode() !== 'workbench') return;
  starting = true;
  let card;
  try {
    card = await import('./components/Tour.js');
  } catch (error) {
    console.error('The tour chunk did not load.', error);
    /* Offered only to someone who asked: an unasked tour that cannot come is no one's loss. */
    if (asked) sayUnavailable();
    return;
  } finally {
    starting = false;
  }
  const { Tour, anchorFor } = card;
  if (host || menuMode() !== 'workbench') return;
  const stops = STOPS.filter((s) => s.anchor === null || anchorFor(s.anchor) !== undefined);
  /* Only the anchorless stop left means the interface it describes is not on
     screen, and one card about walking rows is not a tour. */
  if (stops.filter((s) => s.anchor).length < 2) return;
  host = document.createElement('div');
  host.className = 'tour-host';
  portalRoot().append(host);
  mount(host, createElement(Tour, { stops, onEnd: () => endTour() }));
}

/**
 * Offer it, and show it the first time.
 *
 * The menu item is registered whether or not the tour has been seen: the one
 * thing worse than a tour nobody asked for is one that cannot be found again
 * by somebody who now wants it.
 */
export function initTour() {
  addMenuItem({
    label: say('takeTheTour'),
    scope: 'workbench',
    detail: say('sixThingsWorthKnowing'),
    onSelect: () => {
      void startTour({ asked: true });
    },
  });
  if (tourSeen()) return;
  /* After the first paint, so the stops have something to measure. Two frames
     rather than a timeout: the second one runs after the first has been
     drawn, which is exactly the condition, rather than a guess in
     milliseconds that is wrong on a slow machine. */
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void startTour();
    }),
  );
}
