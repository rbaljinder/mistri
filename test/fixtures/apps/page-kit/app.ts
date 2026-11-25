/*
 * Page kit: the browser gate's own App for the vocabulary a free-form page lays itself out with — a rail beside a
 * main column, rows with a lead and a tone, a button that is a link, a placeholder while a read is out, a segmented
 * choice with counts, a file field, a page that draws its own head, and a `parts` page with one of each kit part
 * (e2e/page-parts-themes.spec.ts reads it in every look). No sign-in: it is a local App. Sized to
 * e2e/page-kit.spec.ts; the names are invented.
 *
 * Two themes the reader may pick declare the page's ground as a part, one on the inset pane and one on the edge pane, so
 * the spec can see a declared part win over the shell's own pane. `PAGE_KIT_HEADER=bar` starts it with the header as a
 * bar across the window rather than in the sidebar: the spec runs a second server for that.
 */
import { action, defineApp, defineTheme, listView } from '@mistriwork/mistri/app';

const grounded = defineTheme({ id: 'grounded', label: 'Grounded', extends: 'lumen', parts: { ground: { ground: 'accentSoft' } } });
const groundedEdge = defineTheme({
  id: 'grounded-edge',
  label: 'Grounded edge',
  extends: 'lumen',
  recipes: { pane: 'edge' },
  parts: { ground: { ground: 'accentSoft' } },
});

export default defineApp({
  id: 'page-kit',
  name: 'Page kit',
  connection: 'page-kit',
  resources: {
    thing: {},
    part: {},
    note: {},
    /* The parts page's rows: a status the theme dresses by its recipe, a sum in money, a date to window on, and one
       verb that is offered only while the deal is open (`unavailable="hide"` hides it on the rest). */
    deal: {
      access: 'write',
      display: {
        stage: { tone: { won: 'good', lost: 'bad', negotiation: 'warn', proposal: 'info', '*': 'neutral' } },
        amount: { format: 'money' },
      },
      actions: { markWon: action('Mark won', { set: { stage: 'won' }, when: 'stage != won and stage != lost' }) },
    },
  },
  views: { things: listView('Things', 'thing') },
  nav: ['things'],
  ui: {
    customThemes: [grounded, groundedEdge],
    /* Asked with `in` first: an App's definition reads only the environment its entry passes, or asks whether it is set. */
    ...('PAGE_KIT_HEADER' in process.env && process.env.PAGE_KIT_HEADER === 'bar' ? { shell: { header: 'bar' as const } } : {}),
    /* The look the App starts in, read from the environment (the spec serves a second look by it and reads the root). */
    ...('PAGE_KIT_PRESET' in process.env && process.env.PAGE_KIT_PRESET ? { theme: { preset: process.env.PAGE_KIT_PRESET } } : {}),
  },
});
