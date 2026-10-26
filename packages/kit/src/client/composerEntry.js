/**
 * The view composer's entry point: its menu item, and the navigation it
 * follows. composer.js — the draft, the paths, the panel — loads the first
 * time a view is opened, from the menu or from a link whose tab is a view;
 * until then a walk update costs one look at the current entry.
 */
import { currentEntry, state, subscribeWalk } from './core.js';
import { addMenuItem } from './menu.js';
import { sayUnavailable } from './components/onDemand.js';
import { viewTabOf } from './composerTab.js';
import { say } from './copy/workbench/composerEntry.js';
import { addHostListener } from './shellHost.js';

/** @type {Promise<typeof import('./composer.js')> | undefined} */
let loading;
/** @type {typeof import('./composer.js') | undefined} */
let composer;
const load = () =>
  (loading ??= import('./composer.js').then(
    (module) => (composer = module),
    (error) => {
      loading = undefined;
      console.error('The composer chunk did not load.', error);
      sayUnavailable();
      throw error;
    },
  ));

/* Reconcile with wherever the app now is. Nothing to load while no view is
   open: composer.js closes an overlay it has, and there is none before it. */
function sync() {
  if (composer) composer.sync();
  else if (state.schema && viewTabOf(currentEntry()) !== null)
    void load().then(
      (module) => module.sync(),
      () => {},
    );
}

function attach() {
  /* Registered rather than inserted. The composer does not need to know what
     else is in the header, and the header does not need to know the composer
     exists — which is what let six top-level buttons become one menu without
     touching this file's reason for existing. */
  addMenuItem({
    label: say('viewsMore'),
    scope: 'workbench',
    detail: say('composeAcrossTables'),
    onSelect: () =>
      void load().then(
        (module) => module.openFromTopbar(),
        () => {},
      ),
  });

  addHostListener(window, 'resize', () => composer?.positionRoot());
  addHostListener(document, 'keydown', (e) => {
    if (e.key === 'Escape') composer?.escapeComposer();
  });

  /* Schema readiness precedes restoration of a cold link's walk. Reconcile
     after the walk changes, outside core's synchronous React paint, rather
     than guessing how long restoration will take. */
  subscribeWalk(() => setTimeout(sync, 0));
  sync();
}

if (document.readyState === 'loading') {
  addHostListener(document, 'DOMContentLoaded', attach);
} else {
  attach();
}
