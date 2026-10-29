/*
 * A published look, as a package writes one (docs: Publish a look): the contract it was written to, and `from`, so its
 * stylesheet, the picture the sheet names and its face are read from this package, not from the App that installs it.
 * The face's file is copied in by the test that installs the package (test/theme-package.test.ts), from the client's
 * own Inter, so no font file is committed twice.
 */
import { defineTheme } from '@mistriwork/mistri/app';

export default defineTheme({
  id: 'daybook',
  label: 'Daybook',
  extends: 'lumen',
  contract: 1,
  from: import.meta.url,
  colors: { light: { band: '#f3efe4' } },
  recipes: { table: 'banded' },
  type: {
    faces: [{ family: 'Daybook Sans', src: './fonts/daybook.woff2', weight: '100 900', subset: false }],
    font: { ui: "'Daybook Sans', system-ui, sans-serif" },
  },
  parts: { stat: { edge: 'lineStrong', radius: 'square' } },
  stylesheet: './daybook.css',
});
