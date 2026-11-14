/* What the kit's slots are dressed by, in cascade order, for an App that installs it. mistri serves a kit's
   stylesheets joined in the order they are imported, inside its `components` layer, so each sheet is imported
   here by itself: a CSS `@import` would not survive being wrapped in a layer. */
import './layers.css';
import '@ui-sdk/core/web.css';
import '../src/theme/tokens.css';
/* The App's theme, read where mistri puts it: its tokens here, its recipes last, over every component. */
import '../src/theme/bridge.css';
import '../src/theme/parts.css';
import '../src/theme/forms.css';
import '../src/theme/overlays.css';
import './kit.css';
import './guest.css';
import '../src/theme/looks.css';
