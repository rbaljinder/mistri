#!/usr/bin/env node
/**
 * The client's size, held to a ceiling. Run by `npm run build`, after Vite.
 *
 * What a first visit must download before anything paints is the page's
 * entry script, the surface chunk the page preloads, everything that script imports statically, and its
 * stylesheet; parts loaded on demand (components/onDemand.tsx) come later and
 * are not counted. That weight only ever grew: it reached 3.4 MB unminified
 * before anyone looked, and was still 1.4 MB minified when a review measured
 * it again. `test/built-client-browser.mjs` measured and asserted nothing.
 *
 * The ceilings sit a little above what ships today, so an ordinary change
 * passes and a new dependency pulled into the entry does not. Raising one is
 * allowed; it is a decision, made in this file, with the reason beside it —
 * and moving the new weight behind `onDemand` is usually the better answer.
 *
 * What the page then does with those bytes — how late its largest paint is,
 * whether anything moves under the reader, how long a click takes to answer —
 * has budgets of its own beside these, in test/built-client-vitals.mjs.
 *
 * @mistriwork/mistri/react (dist/embed) has ceilings of its own, `EMBED_BUDGET` below,
 * and must hold no require() at all (`embedRequires`): it is ES modules a
 * host's bundler or browser takes in, where a CommonJS call has nothing to
 * call. One left by a bundled dependency stopped the built embed starting.
 *
 *   node scripts/bundle-budget.mjs          check the kit's dist/client and mistri's dist/embed
 *   node scripts/bundle-budget.mjs --print  say the sizes, check nothing
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Each binary's built client (vite.tablewalk.config.ts, vite.mistri.config.ts): each is held to its own ceilings. */
export const CLIENTS = {
  tablewalk: join(ROOT, 'packages/tablewalk/dist/client'),
  mistri: join(ROOT, 'packages/mistri/dist/client'),
};
const EMBED = join(ROOT, 'packages/mistri/dist/embed/react');

/* Bytes, per first page. Brotli is what a browser is sent (the server
   prefers the `.br` beside each file); raw is what it parses and compiles.

   Each surface is its own first page (vite.config.ts, `surfaces`): the
   entry, the chunk its page preloads, and what those import statically.
   The Workbench is the shell's page and the Workbench's own chunk, which
   the shell loads the moment it shows the Workbench. Before the split, at
   0.8.0, every page was one script, 1,416,155 raw / 352,764 br, and one
   stylesheet, 285,932 / 40,465. After it, raw / br:
     public     script 647,899 / 176,299 (the sign-in screen, a public form)
     app        script 1,204,892 / 322,970, and the shell's own 1.4 KB of style
     workbench  script 1,217,391 / 327,365
   The stylesheet is otherwise still one, on every page: 293,274 / 41,472.
   The ceilings sit about 2% above, to lock the split in. Then the App
   manifest parser left first paint (the first paint imports no parser:
   test/repo/structure.test.ts), and the ceilings came down with it:
     public     script 612,659 / 167,014
     app        script 1,195,622 / 321,126
     workbench  script 1,208,115 / 325,530
   The stylesheet's ceiling rose from 301,000 to 304,000 raw at 0.8.0's
   close: the inbox bell in the App bar, a room's body, a vocabulary's marks
   and a photo avatar's fallback are drawn on the first page (301,466 raw
   together). Then each opt-in look's own rules left the first stylesheet
   (irisLook.css, inkLook.css, sageLook.css, signalLook.css, beside Tray's,
   and Lumen's since 0.8.8:
   visualTheme.ts fetches the worn one), leaving what every look shares and
   Mono, the default. Raw / br after it:
     public     style 287,959 / 41,164
     app        style 289,824 / 41,733 (the Workbench's the same)
   and the style ceilings came down to about 2% above.
   0.8.1's shared list work is on every list's first page: a reference
   column drawn by its record's name, date presets that fit the column,
   rule words, and the filter rail's batched counts. Script raw / br after it, to the hundred:
     app        script 1,219,700 / 327,300
     workbench  script 1,232,200 / 331,700
   and the script ceilings rose about 0.5%, to 1,226,000 and 1,238,000 raw.
   Then a form's review step and leave guard joined FormSurface, which the
   App's own form dialog draws (a form saved on every step is fetched only
   when one is shown), and the brotli ceilings rose 1 KB, to 329,000 and
   333,000. Then, with no Workbench in an App, two of its tools left the
   shell: the view composer (composerEntry.js keeps its menu item and loads
   it when a view opens) and the query language's help text (helpContent.js,
   loaded with its panel). And the public page stopped carrying the CSV
   import's parser (a transport that only sizes a request reads its limits
   from appImportDeclaration.ts) and the saved-form API (FormSurface arms
   formLeaveGuard.ts; the surfaces that save fetch the rest). Script raw / br
   after it:
     public     script 624,038 / 170,198
     app        script 1,201,284 / 321,753
     workbench  script 1,213,790 / 326,164
   and the App's and the Workbench's script ceilings came down to about 1%
   above. Then shape became the look's (docs/design.md, Shape): every popup,
   panel and dialog names its role's corner token instead of a literal, a
   small mark `min(3px, var(--radius))`, and the database browser's own lifts
   stand in pinned rules beside the popups they belong to, so the Workbench
   is unchanged while every look's popups follow its fields. About 3 KB raw
   and 0.2 KB in brotli on every first page, and the style ceilings rose by as
   much: public 297,000 / 42,500, the App's and the Workbench's 299,000 /
   43,000. The script had meanwhile passed its ceilings: an App list's
   column menu (1a830744) and its filters said in words (9fb7e780) took the
   App's first page from 1,212,771 to 1,235,493 raw. Then the menu's open
   half (AppColumnMenuPopups.tsx) and the words (conditionWords.ts, with its
   own table of them) left for parts loaded on demand — the first time a ⌄
   is used, or an App's list has a condition to say — and the interface's
   words moved into the catalog (packages/kit/src/client/messages.ts says how): each
   module's copy is a table of its own under src/client/copy/<room>/,
   downloaded with the module, its keys shortened to a letter in the build
   (vite.config.ts, `shortCatalogKeys`), and a word two first-page tables
   shared said once, in messages.ts. Script raw / br, before and after:
     public     628,916 / 171,483  ->  630,742 / 172,708
     app        1,235,493 / 330,599  ->  1,239,317 / 333,640
     workbench  1,247,999 / 334,999  ->  1,252,237 / 338,222
   and the script ceilings sit about 1% above. The stylesheet then passed
   its raw ceilings by under half a kilobyte, still inside its brotli ones:
   0.8.1's record anatomy (a header's status chip and facts line, the aside's
   card and rail), a tenant's name ending in an ellipsis in the phone's bar,
   and the list's filter words each brought a few rules. Style raw / br:
     public     297,431 / 41.3 KB     app and Workbench  299,315 / 41.8 KB
   and the raw style ceilings rose by 2,000, to 299,000 and 301,000.
   0.8.2 made the first page and every navigation paint finished: a
   navigation holds the screen it leaves until the new room is complete
   (navigationHold.ts, pendingWork.ts, on every first page, since api() and
   the on-demand loader report to it), and a first page keeps its veil up
   until its room is quiet (startupHold.ts, in the entry). Places held for
   what arrives late (a count's two digits, Export beside New, a metric's
   figure, a record's facts and verbs) and date formatters made once came
   with them. The navigation hold alone took every first page past its
   script ceilings; the rest added about 0.7 KB raw / 0.3 KB br to the
   public page and 2.2 / 0.6 to the App's. Script raw / br, and style br,
   after it:
     public     638,546 / 175,229    style br 42,519
     app        1,256,066 / 338,625  style br 43,088
     workbench  1,269,035 / 343,232  style br 43,088
   and the ceilings sit about 0.5% above: they measure what a first visit
   needs to paint without moving, which these bought (test/built-client-vitals.mjs).
   Then a record page became one request: the builders every section and the
   server share (shared/recordReads.ts), the answers kept for the sections
   (composedReads.ts, told to core.js as it loads, so the public page carries
   none of it), a press on a row that starts the page (recordPress.ts), and a
   page that arrives past the hold's cap shown whole (PageRoom.tsx). About
   8.4 KB raw / 2.3 KB br on the App's and the Workbench's first page, and
   1.3 / 0.3 on the public page (a tenant page letting its context go).
   Script raw / br after it:
     public     640,301 / 175,653
     app        1,265,827 / 341,317
     workbench  1,278,796 / 345,920
   and the App's and the Workbench's script ceilings sit about 0.5% above:
   the page is on screen a navigation's worth sooner for them.
   Computed columns and named action IDs measured 643,348 raw / 176,178 br
   on the public surface, without the App manifest parser. First-paint data
   reuse adds the page-block reader and shared request keys (about 2.4 KB raw
   / 0.5 KB br); the public ceiling includes that addition. App and Workbench
   retain their existing limits.
   0.8.7: a field's text rule (its message under the box) and the tag chips a
   New form now offers are drawn on public forms too, which took the public
   style to 299,110 raw; its ceiling moves to 300,000 (br unchanged).
   0.8.7's desk blocks (a conversation's rows, tints and composer, a split's chosen rows and key hints, the quiet
   chrome roles, the sidebar's foot) added about 3 KB raw / 0.9 KB br of rules to the one stylesheet every first
   page carries: public 301,978 / 43,110, App and Workbench 302,490 / 43,315; the style ceilings sit about 0.5%
   above.
   0.8.8's rich text is drawn on any record page, card or list cell that holds a value: the allowlist and the plain
   words (shared/richText.ts), the renderer (components/RichText.tsx) and a picture's address (fileSource.ts), about
   2.2 KB br on the App's and the Workbench's first page, and its reading rules (.rich-text in page.css) about 0.8 KB
   raw on every page. The editor and its own rules stay a part loaded on demand (RichTextEditor). After it: app
   script 1,267,643 / 345,222, workbench 1,280,617 / 349,832, style raw 304,376 public and 304,822 App and Workbench;
   those ceilings sit about 0.5% above.
   0.8.8 wave 2b: a card's icon before its title, a list's tab strip fading at the edge while there is more to scroll
   to, and a key hint legible on a filled button are rules of the first stylesheet (cards, lists and the action bar
   are first-page rooms). After trimming them: App and Workbench style 305,609 / 43,901, one byte past the
   brotli ceiling, which moves to 44,100 (about 0.5% above).
   0.8.8 wave 3: row-defined fields. The drawing (DefinedFields.tsx) is a part loaded on demand, but what every
   record page, list and form must know before it can ask for it is first-page code: a JSON key as a path the
   query language filters, sorts and counts by (viewPaths, viewLabels, query, filter), the binding as the App
   declares and checks it (definedFields.ts, through shared/app.ts), a field folded into its column's object at
   Save (write.js), and the bound column handed on by the record page, the New form and a list's filters. About
   5.1 KB raw / 0.6 KB br on the App's and the Workbench's first page. After it: app script 1,277,133 / 347,648,
   workbench 1,290,138 / 352,256; those ceilings sit about 0.5% above.
   0.8.9: the looks became specs (defineTheme) built by the same builder an App's theme goes through. Built in the
   browser, the builder and the validator stood in every first page (about 13 KB raw / 4 KB br): a module a
   first-page file imports is in the first page whole, and the validator shared modules with the tokens. Now the
   looks are built ahead of time (scripts/theme-presets.mjs, packages/engine/src/shared/builtInThemes.ts), the tokens and the
   recipe menu are modules of their own, the export control and its chooser are a part loaded on demand
   (ExportHold.tsx holds its place), the charts' drawing rules moved to their own sheet (Chart.css) and a file
   preview's to its (FilePreview.css), and the built looks are written with each palette as its values in one
   order (scripts/theme-presets.mjs), not its role names 34 times over. The built definitions of nine looks are
   still more than 0.8.8's hand-written eight: the public page's script is 636,060 / 177,937, about 0.4 KB br past
   its ceiling, which moves to 178,600 (0.3% above). Every other ceiling holds: app 1,279,761 / 348,796,
   workbench 1,292,735 / 353,415, style 304,707 / 43,705 (public) and 305,153 / 43,897.
   0.8.9 cut the built-in looks to Lumen, Mono and Sage (the rest are defineTheme examples), and their built
   definitions with them: about 7.9 KB raw / 1.7 KB br off every first page's script, the style unchanged (each
   look's own rules were already fetched when worn). Script raw / br after it: public 628,137 / 176,172, app
   1,271,838 / 347,160, workbench 1,284,812 / 351,770, and the script ceilings came down to about 0.5% above.
   0.8.13 kept a New form's switch out of the looks' control and field rules (a `:not([role=switch])` in four
   selectors), which took the public style from 43,790 to 43,834 br, 34 bytes past its ceiling; it moves to 43,900.
   0.8.14's five blocks are first-page code where a list, a record page or a chart is: a list's `suggest` and a
   card's one-hop paths as the App declares and checks them (appViews.ts, appCards.ts through shared/app.ts), a
   week's bucket and its "Oct 6" tick (Chart), a headline's `was` (PageHeadline) and the filter boxes handing a
   text box to the suggesting one. The suggesting box itself is a part loaded on demand (SuggestBox). About 1.1 KB
   raw / 0.1 KB br on the App's and the Workbench's first page: app 1,279,283 raw, workbench 1,292,288, 1.1 KB past
   their raw ceilings, which move to 1,281,000 and 1,294,000; brotli and style hold.
   0.8.14's New menu (`ui.shell.new`) is a part loaded on demand — the button, its menu and stylesheet
   (NewMenu.tsx) and the reading of which lines a reader may use (newMenuModel.ts), which the palette fetches too.
   What stays on the shell's first page is the host it mounts in and the palette's fetch of those lines: the App's
   first page at 348,981 br, 81 bytes past its ceiling, and the Workbench's at 353,592, 8 bytes short of it. The
   brotli ceilings move 200 bytes, to 349,100 and 353,800.
   0.8.14's fixes from a service-desk App are first-page code where a record page, an address or a tenant's door is: a
   timeline's side read per stream (timelineSides in shared/page.ts, a stream's own `side` in pageConfig.ts), a
   table's name over a record read as its view (shared/appAddress.ts) and the tenant door holding its chooser until
   discovery answers (tenantBrowser.ts). The App's first page is 349,183 br, 83 bytes past its ceiling, which moves
   to 349,300; the Workbench's, 353,796, holds.
   1.0's embed seams: every page global, listener and request the shell makes goes through one host module
   (shellHost.ts, addressMount.js, transport.ts), and boot's sequence is a module of its own (shellStart.js), so
   @mistriwork/mistri/react starts the same shell inside a host's route. Every page boots through them, so they are first
   paint by nature; raw barely moved, but named calls compress worse than the `document.`/`window.` spellings they
   replaced. Then server-rendered public pages: a page the server drew is hydrated rather than drawn afresh
   (serverDrawing.js, which keeps react-dom's hydrateRoot in the entry), and an uploaded picture is offered at
   the widths the server makes of it (imageWidths.ts, on a landing, a card and a gallery), about 1.4 KB raw /
   0.6 KB br on the public page and 0.9 KB raw on the shell's. Against that, the palette (Palette.tsx) left the
   shell's first page for a part loaded on demand, and a dashboard's per-currency split (Dashboard.tsx) left
   dashboardModel.ts, which first-page record metrics import: about 4.7 KB raw / 1.2 KB br off the App's and the
   Workbench's first page. Script raw / br after it: public 632,134 / 177,847, app 1,276,815 / 349,661,
   workbench 1,289,704 / 354,278. The public raw ceiling moves to 632,500 and the brotli ceilings to 178,000,
   349,800 and 354,400: the entry names every chunk by its hash, and builds of one raw size have measured up to
   120 bytes apart in brotli, so a ceiling closer than that fails on a rename.
   1.0's service-desk blocks (a breakdown's goals, a page's figure words, a union's row opening its own record) were
   paid for by the cards and the gallery leaving the shell's first page for parts loaded on demand (CardsList.tsx,
   Gallery.tsx; what a list asks before drawing cards stays, in cardsModel.ts): app 1,273,898 / 349,276,
   workbench 1,286,787 / 353,896, about 7 KB raw and 1.4 KB br below where they stood. No ceiling moved.
   0.9.0 brought first-page code where an address, a form or a record page is: a tenant's public reads placed by
   `?via=` (addressMount.js, tenantPublicReads), the chrome's words per reader's language (and with them a
   716-byte rolldown runtime chunk beside the entry, which compresses on its own), a command's `defined` and `when`
   inputs (commandInput), a record command's prepare (FormRoom) and a page's related lists and cards (PageRelated,
   appCards). Against that, a command form's reference picker with its combobox (CommandReference.tsx) and its
   defined questions (CommandAnswers.tsx, with the defined values' reading in shared/definedValues.ts) left the
   first page for parts loaded on demand: they are asked only of a signed-in reader with a connection, never of a
   public form. Script raw / br after it: public 600,830 / 170,083, app 1,278,037 / 351,178, workbench 1,291,009 /
   355,829. The public ceilings come down to 604,000 / 171,000 to hold that trim; the brotli ceilings of the App
   and the Workbench move to 351,500 and 356,100 (raw holds), since what was left is code every such page runs.
   1.0's command lines (`field.lines`): the grid (CommandLines.tsx, FormLines.tsx), a cell read as its column's kind
   (shared/commandLineCell.ts) and the words for a cell are parts loaded on demand, never on a public form's first
   page. What a command form must hold before the grid arrives stays: its lines as values (blank, prefilled, sent),
   the reader's row shape and count (readLines in commandInput.ts) and the branch that draws the grid. Script raw /
   br after it: public 603,110 / 170,572, app 1,280,230 / 351,589, workbench 1,293,202 / 356,220. The App's and
   the Workbench's brotli ceilings move 300 bytes, to 351,800 and 356,400; raw and the public page hold.
   The 1.0 gaps after it put code every App page runs on the first page: a true/false field edited in its display
   rule's words (booleanWords in valueModel.ts, Editable.tsx), a measure of seconds said as a time taken
   (dashboardModel.ts), a reference picker that says it is wrong (RecordPicker.tsx) and whether the header offers its search to
   a signed-out visitor (headerSearchShown in publicVisitor.ts); the Workbench also holds a tenant address that names
   no workspace (showNoWorkspace in welcome.js). None is a part a page could wait for, so nothing moved behind
   onDemand.tsx. Script raw / br after it: public 603,364 / 170,787, app 1,281,586 / 352,110, workbench 1,294,896 /
   356,824. The App's ceilings move to 1,282,000 / 352,400 and the Workbench's to 1,295,500 / 357,100; the public
   page holds.
   The record page's sizing fixes after it are code and rules every record page runs: a related
   list's Add and the record's verbs it draws in its head (PageRelated, Page's head giving them up), a fit grid's
   water-fill and a dressed date sized by its words (gridSizing.ts, Grid.tsx), a row's ⋯ in its own column
   (features.css) and a run of figures' hairline in the gap (page.css). A related list is on the first page of
   every record, so nothing could wait for onDemand.tsx. Script raw / br after it: app 1,282,768 / 352,439,
   workbench 1,296,078 / 357,158; style br 43,934 (public) and 44,126. The ceilings move to 1,283,000 / 352,600
   and 1,296,500 / 357,300, and the style brotli ceilings 100 bytes, to 44,000 and 44,200.
   The shell's Spanish words are words and code the shell draws before anything else: the chrome's own words in Spanish
   (each shell table's `es`, beside its English as every room's is, so a Spanish visitor's skip link, menus and
   crumbs are never English while copy/es.ts arrives), the shell re-saying them when the language changes, and a
   dashboard's declared window in its address (dashboardModel.ts, publicAddress.ts). Moving one language's room
   tables into its own chunk would undo the rule that a module brings its words with it (messages.ts), so nothing
   moved. Script raw / br after it: app 1,283,879 / 352,787, workbench 1,297,189 / 357,510. The ceilings move to
   1,284,300 / 353,000 and 1,297,600 / 357,700.
   The phone fixes after them are rules every first page holds and code the shell's account menu runs: a tenant App's
   bar on a phone (its context the account menu's first item, tenantContextEntry.ts; New its plus; the brand giving
   way to its mark by a container query), a strip's mark at its card's right and a record's figures two to a row on
   a phone (structure.css). They are the bar and the first screen of a dashboard or a record, so nothing could wait
   for onDemand.tsx; the old phone rules they replace went (style.css, page.css, features.css), and a hover and a
   sandbox chip's alignment were trimmed. Style raw / br after it: public 306,399 / 44,053, app and Workbench
   306,845 / 44,245; script br app 353,124 and Workbench 357,839 (raw moved 8 bytes: the rest is a chunk's hash).
   The style ceilings move to 306,800 / 44,100 and 307,200 / 44,300, the script brotli ones to 353,300 and 358,000.
   The side menu's fade tied to its scroll (features.css: it covered the last entry of a list that fit, and the
   workspace name's second line) cost about 70 bytes of brotli net of the rail rule it made redundant, which went:
   public 306,471 / 44,115, app and Workbench 306,917 / 44,307. The brotli style ceilings move to 44,200 and 44,400.
   The release review's cut words, fixed where a list, a card and a field are drawn on every first page (Grid.tsx,
   gridSizing.ts, RecordSummaries.tsx, PageFields.tsx): a number sized by the figures it draws, a list's name kept
   whole before a table scrolls, a tags cell drawing whole chips and counting the rest (measured per cell, so it
   cannot wait for onDemand.tsx without its chips arriving late), a link row titled by the row it links to, and long
   text under its caption in a property rail. The style they needed came out of rules nothing draws any more (the
   App definition dialog, the landing's old sub-heads, a connection label, an attachment's Details link, a command's
   label, a pending dock's finish button): style fell about 1,100 bytes. Script raw / br after it: app 1,285,545 /
   353,577, Workbench 1,298,855 / 358,292. The script ceilings move to 1,285,700 / 353,700 and 1,299,000 / 358,400.
   Lumen's refresh is the default App look, so its rules are every App's first paint: a list's open table, quiet
   status dots and its name column (lumenLook.css), a workflow as a segment track (page.css), a head that stays in
   view under the trail (useStickyHead.ts, style.css) and skeleton rows the height of the rows they stand for. The
   script beside it draws a list's first screen: tab counts held while the next batch loads (AppList.tsx), money set
   to the cents its column needs (valueModel.ts), work counts in the menu (menuCounts.ts) and a chart's round ticks
   (niceTicks.ts). Each paints before anything onDemand.tsx could fetch, so nothing moved. Style raw / br after it:
   public 309,576 / 44,609, app and Workbench 310,022 / 44,801; script app 1,292,842 / 355,578, Workbench 1,306,152
   / 360,289. The style ceilings move to 310,000 / 44,700 and 310,400 / 44,900, the script ones to 1,293,300 /
   355,700 and 1,306,600 / 360,400.
   The 1.0 gap fixes that arrived beside it are first-paint too: a related list's verbs in its heading row and a
   phone's list tabs on a row of their own (structure.css), a row that opens the record its join row names
   (rowOpens.ts, Grid.tsx) and a command with no inputs sent in one click (commandSend.ts), each drawn by a list or
   a record before anything onDemand.tsx fetches. After them: style public 310,363 / 44,704, app and Workbench
   310,809 / 44,896; script app 1,296,031 / 356,559, Workbench 1,309,341 / 361,275. The ceilings move to 310,600 /
   44,800 and 311,000 / 45,000 for style, 1,296,500 / 356,700 and 1,309,800 / 361,400 for script.
   0.9.1's segments, cross-table filters and consumes are drawn by a list's first screen: a tab that names a
   segment, a filter rail reaching a parent's column or a child's rows (stitchedPaths.ts, the filter bar's `has`
   entries), a line's consumed balance said in the command's message, and the conventions that draw a column the
   App says nothing about (displayDefaults.ts). Each paints before anything onDemand.tsx fetches. After them, in
   KiB: public script 591.3 / 167.3, style 303.8; app script 1,273.0 / 350.1, Workbench 1,287.4 / 355.1, style
   304.3; the embedded shell 513.6 / 81.1. Each ceiling moves to about 0.3% above.
   Two first-paint rules then held still what moved: a table head's menu caret stands past its label, not over it
   (a click on a short label opened the menu), and on a phone a record room arrives by its ink, since the entrance's
   transform carried the fixed verb bar with it (style.css). The brotli style ceilings move 200 bytes, to 45,000 and
   45,200.
   0.9.2's theme wave B dresses every first page: the menu drawn in nav.* under every bar recipe and either
   placement, an App form's fields at 44px on a touch screen, a pill's corner and a control's edge as tokens
   (structure.css), a section's heading and a lane's value as recipes (brandLook.css), and the switches that wear
   them and hold the theme bench's mode (appTheme.js, theme.js, shellStart.js — the bench itself is a part loaded
   only in a dev server's frame). A theme is worn before the first paint, so none of it can wait for onDemand.tsx.
   After it, in KiB: public script 593.4 / 168.3, style 307.0 / 44.0; app and Workbench style 307.4 / 44.2,
   Workbench script br 356.2; the embedded shell 517.3 / 81.4. Each ceiling it passed moves to about 0.3% above.
   0.9.2's wave F gives a metric card its whole figure beside the compact one it shows (dashboardModel.ts,
   Dashboard.tsx) and a gallery a button of its own to open the photo (Gallery.tsx); both draw at first paint.
   After it, in KiB: app script 1277.2, Workbench script 1291.6, and those ceilings move to about 0.3% above.
   CI's build then measured the App's script past its brotli ceiling by bytes the local build had under it, and the
   brotli style ceilings sat within a hundred bytes of theirs; the App's script br moves to 360,400 and each brotli
   style ceiling 300 bytes, so a compressor's few bytes between machines do not fail a release.
   0.9.3 left the raw style within 0.1% of its ceilings (public 315,107, app and Workbench 315,551), where any rule
   a first page draws fails the build; each raw style ceiling moves to about 0.3% above.
   0.9.4 dresses every first page in the frozen theme vocabulary — type roles on the root, part styles, surfaces,
   band, shadow and motion tokens, the logo's light and dark pictures — and draws the punch list's first-screen fixes.
   Slimming it behind onDemand.tsx is planned for the next release; after it, in KiB: public script 602.8 / 170.8,
   style 334.8 / 45.7; app script 1287.7 / 354.4, Workbench 1302.1 / 359.5, style 335.2 / 45.9; the embedded shell
   544.9 / 83.3. Each ceiling it passed moves to about 0.3% above.
   0.9.5 grew every first page by what its theme work and page model need before anything can be fetched: a theme's
   accent inks and scheme are worn before the first paint (themeInk.ts, themePresets.ts, themeRecipes.ts,
   visualTheme.ts — the sign-in screen and a public form wear a tenant's theme too), the App model's new
   vocabulary (funnel, layout, empty, face) is parsed where an App is read, and a record page's related lists,
   empty runs and sections draw on the first page of every record. Against that, a grouped related list
   (PageGroups.tsx) moved behind onDemand.tsx, which took 3.8 KiB raw off the App and the Workbench. After it, in
   KiB: public script 606.2 / 171.7, style 338.7 / 46.1; app script 1296.2 / 356.8, Workbench 1310.6 / 361.9, style
   339.2 / 46.3; the embedded shell 550.6 / 83.9. Each ceiling it passed moves to about 0.3% above.
   0.9.5's design pass then dressed every first page again: the space and text scales are tokens on the root
   (--space-*, --text-*, the rhythm and row-height steps), so some three thousand literals became var() calls, which
   is most of the style's growth (about 18 KiB raw, 1.7 KiB br); the head recipe and band, a metric's comparison
   and its trend line, the states a room is drawn in when it is empty, refused or broken, the public top bar, a
   record page's layout and a list head's second line all draw before anything is fetched. After it, in KiB: public
   script 610.3 / 172.7, style 357.8 / 47.9; app script 1306.3 / 359.6, Workbench 1321.0 / 364.8, style 358.3 / 48.1;
   the embedded shell 572.0 / 85.9. Each ceiling it passed moves to about 0.3% above.
   0.9.6's layout pass keeps every App table, matrix and control strip inside its box (a value's two-line wrap, the
   folded columns' detail line, a matrix folded to labelled cells, the phone strip's second line) and snaps a
   hundred 3px and 20px literals to the scale's var() calls; all of it draws at first paint. After it, in KiB: public
   style 360.7, app and Workbench style 361.2; the embedded shell 575.4. Those raw style ceilings move to about 0.3%
   above; the brotli ones did not move.
   0.9.6's states pass draws what a first page needs while it waits or when it has nothing: a dashboard's metric
   bar, a chart's held room and a breakdown's rows, an empty tab's sentence and a list's Try again, an App's dates
   said from today (locale.ts sayNearDay) and a few lines named at their ends. The record page's placeholder anatomy,
   drawn only past the navigation hold's cap, went behind onDemand.tsx with its stylesheet (PageSkeleton.tsx), which
   kept every style ceiling and the public script where they were. After it, in KiB: app script 1311.3 / 361.0,
   Workbench 1325.9 / 366.1; the embedded shell 577.4 raw. Those ceilings move to about 0.3% above.
   0.9.6's phone pass draws at first paint too: a record's facts beside their captions, the Records/Table switch at
   the end of the tab strip and the strip's fade, a full-width drawer with its actions at its foot, Import as a mark,
   tags as chips wherever a value is drawn (Value.tsx) and the slot the switch is drawn into (crumbSlot.ts), none of
   it a part a reader could wait for. After it, in KiB: public style 362.5 / 48.4; app script 1310.8 / 360.8,
   Workbench 1325.4 / 365.9, style 363.0 / 48.6; the embedded shell 578.7. Each ceiling it passed moves to about
   0.3% above.
   0.9.6's mode seam puts the shell's answers to the kit in one module (shellMode.ts, its Workbench defaults
   beside it) where a dozen setters were, and a public page names the ones it shares with the App shell
   (surfaceShell.js, sdk/appComponents.ts) because core.js and the input slot no longer import the tenant's
   transport and the component loader themselves. About 1.2 KB raw / 0.7 KB br on the public page, 0.5 / 0.6 on
   the App's and the Workbench's. After it: public script 626,879 / 177,686, its ceilings move to 628,800 /
   178,200; the others hold.
   0.9.6's shell split gives each product its own shell over the kit's (app.js, shells.ts): the App framework's
   chrome stays on every first page (appnav.js, appChrome.js), since the server sends one shell page to both and
   only the runtime says which answers, while the Workbench's tools (the SQL pane, Undo, the connection picker and
   manager, the query bar's commands, workbench.js) left the shell chunk for the workbench one. The App's first
   paint lost 14.6 KiB raw / 3.6 br: app script 1299.5 / 358.0, its ceilings come down to about 0.3% above. The
   Workbench downloads the same modules as before, now in two chunks, and the workbench chunk names what it reads
   from the shell's by name; that is 2.6 KiB raw / 1.8 br: Workbench script 1331.3 / 368.6, and its ceilings rise
   to about 0.3% above.
   0.9.8's embed fix sends an App's theme files — faces, its stylesheet, logo pictures — through the address seam's
   appFile, as component files go, so an embed fetches them from its endpoint and not the host's address; the served
   page names one more seam export (appFileUnplaced). 42 bytes raw on the public page, from 628,780 to 628,822, over
   a ceiling 20 bytes above it: the public raw ceiling moves to 629,500.
   0.9.8's two shells left the App framework's chrome (appnav.js and what only it reaches) in the shell chunk, so the
   Workbench's page fetched it too: Workbench script 1,366,199 / 379,229, past its brotli ceiling. The chrome is a
   chunk of its own now (vite.config.ts `surfaces`), which the App's page preloads beside the shell, so the two
   download at once; what a part the Workbench may load on demand shares with the chrome stays in the shell, or that
   part would fetch the chrome's chunk. The Workbench's first paint is 1,274,630 / 356,903, and its ceilings come down
   to about 0.3% above. The App's page downloads what it did, in one more file, and brotli compresses two files apart
   about 5 KB worse than one (the chrome cannot use the shell's text as its dictionary): 1,334,132 / 373,116 from
   1,331,391 / 367,612, and its brotli ceiling moves to about 0.3% above. Merging the two again would put the chrome
   back on the Workbench's page; 5.5 KB on the App's first paint buys 22 KB off the Workbench's.
   The public page's entry carries Vite's table of the lazy chunks' file names (each import()'s preloads), and every
   chunk named in it, the chrome now among them, is a content hash brotli cannot shorten. Dropping the modulepreload
   polyfill was tried and saved 10 bytes brotli, not worth Safari 16's preloads. Public script 628,886 / 178,305 (it
   was 178,424 before the chrome left the shell), and its brotli ceiling moves to 178,800.
   0.9.9's field fixes are drawn on every first page: a matrix's strongest heat tint, measured against the look's
   ink (heatTop, in its own small module, themeColor.ts, so the first paint does not carry theme.ts's checks: that
   import alone had added 8 KB), a conversation kept at its foot as it settles, a worded yes-or-no sized to its
   words, and their rules in the stylesheet. Public script 630,389 (from about 628,840), App script 1,337,005 (from
   about 1,334,580), style 372,451 public and 372,950 on the shell's pages, all inside their brotli ceilings: the raw
   ceilings move to about 0.2% above.
   0.9.9's live sync is first-page code where it must be: the key and pulse rules and the hold registry (liveState.ts,
   which Grid, TableRoom, the record head and the draft bar read), the header filing every read's tables
   (liveReads.ts, core.js), the QueryCache that keeps them (mount.tsx) and the row tint's rules. The stream, the
   invalidation map, the engagement rules, the tenant request and the three notices (LiveNotices.tsx) are parts loaded
   on demand. Against the base: public +0.4 KB raw / 0 br, style +0.4 / +0.1; App and Workbench script +4.3 KB raw /
   +1.0 KB br, style +0.4 / +0.1. The ceilings move by that and about 100 bytes.
   Merged with the rest of 0.9.9 (the freeze renames, the catalog's words for a picker's note) the first pages measured
   brotli 179,031 public, 375,231 App and 358,953 Workbench, 31 to 53 bytes past: the brotli ceilings move 100 bytes.
   The two live-sync UI fixes (the record head reserves the draft notice's row from the first edit, so a change moves
   nothing; a changed row's own amber hue instead of the accent) added the head's draft subscription to the shell's
   script and a few rules to the stylesheet: App script 1,341,958 / 375,402 (+458 raw, +102 br past the last ceiling),
   Workbench script 1,282,090, public style 373,247, shell style 373,746 / 50,020. Ceilings move by that and about
   100 bytes. Workbench script brotli measured 359,092 once the chunk names settled (the hashes of the lazy chunks are
   in the entry and brotli cannot shorten them): its ceiling is 359,200.
   Live sync made an App's choice (`live: true`, a resource's `live: false`) put the tables `hello` names as off, and
   the dashboard's minute read when the page follows nothing, in liveState.ts: App and Workbench script under 0.2 KB
   raw past their ceilings, brotli inside. The raw ceilings move 200 bytes.
   The split into packages (1.0 step 1) moved every module to packages/<name>/src with its code unchanged; the page is
   now built into packages/kit/dist/client. Vite orders a chunk's modules, and the minifier names their bindings, by
   module path, and the App's first paint measured 1,342,505 / 375,647: 205 raw and 147 brotli bytes past, the other
   pages inside. The App's script ceilings move by that and about 100 bytes.
   Icon and DateField moved into @mistriwork/ui with their words and glyphs as props: the kit hands the catalog's words to
   DateField and registers its glyphs, its loader and its weight with Icon, where they were imports before. That seam
   measured 631,816 public, 1,343,044 App and 1,283,140 Workbench raw, 116 to 740 bytes past, and those ceilings move
   by that and about 100 bytes. Brotli is not the same from one build of the same source to the next: Rolldown writes
   a CommonJS interop call in a part loaded on demand (LiveNotices) with or without its second argument, that part's
   name changes, and so does every chunk list that names it. Four builds measured 179,231 to 179,353 public, 375,780 to
   375,946 App and 359,426 to 359,575 Workbench; the brotli ceilings sit about 150 bytes above the highest.
   At the binaries' split each product builds its own client, without the other's main (vite.config.ts,
   `withoutOtherMain`), and its first pages are held here under its own name: the App framework's public and App
   pages, the database browser's Workbench. The ceilings are the ones the one build was held to; a product's build
   that came in under them keeps them until it is measured again.
   A strip of tabs fits its row instead of scrolling (useTabFold.ts): a record's and a list's strip measure their
   tabs before the first paint and put what does not fit under a More, so the fold, its menu and its rules are first-
   page code, or a strip would be drawn too wide and then shrink. After it: public style 374,190 / 49,972; App script
   1,345,500 / 376,330, Workbench 1,285,507 / 359,899, style 374,689 / 50,192. Each ceiling it passed moves to about
   0.1% above.
   The fold landed beside the split, so its bytes sit on top of the split's ceilings: each ceiling the fold passed
   moves by what the fold added (App script +3,700 / +1,200, Workbench script +3,600 / +1,100, style +1,250 / +200 to
   +300).
   Decisions put two slots on every first page: the kit asks the shell for a record field's adornment (Page.tsx), a
   header holds an empty fact's line while a decision is asked of it (PageHead.tsx), and a list asks for its cells'
   marks (Grid.tsx); the shell answers them with two small hooks (decisionAdornment.tsx, decisionMarks.tsx), their
   words and the rules for a held suggestion and a list mark (decisionMarks.css). The chip itself, its menu, "Why
   this?" and its stylesheet are a part loaded the first time a record has a suggestion, so an App that decides
   nothing never fetches them. App script 1,346,047 / 376,796 and style 374,032 / 50,107, Workbench script
   1,284,177 / 359,870 (the kit's half), public script brotli 179,351 (the lazy chunks' hashed names in the entry;
   its raw grew 27 bytes): the ceilings move by that and about 100 bytes.
   Decisions landed beside the split and the tab fold, so their bytes sit on top of those ceilings: App script
   +2,950 / +1,150 and style +300 / +100, Workbench script +1,000 / +570, public script +50 / +250.
   1.0.0-rc.1's motion doctrine adds the --ease-drawer token to the root (about 60 bytes of style on every page);
   the three raw style ceilings rise by 200.
   A move is drawn at its drop (optimisticMoves.ts) by every hand-ordered list, and a grouped related list moves its
   rows between groups (groupMoves.tsx): both are a record page's and a list's first-page code, as the hook they ride
   on (usePointerDrag.tsx) already was; their rules ride the board's chunk, not the first page's stylesheet. App
   script 1,318.8 KB raw, its brotli under its ceiling: the raw ceiling moves to about 0.1% above.
   rc.1's forms wave 2 adds to every form the field vocabulary's reader and controls' dispatch (commandInput.ts, money,
   month, choices with bounds, masks, sensitive keeps, `as`; CommandFields.tsx) and the intake frame's glue
   (FormSurface.tsx, reviewValues.ts), which every public page carries because a public form is that page's own
   content: public script +5.9 KB / +1.6 KB over 1.0.0-rc.1's base build, App script +5.5 KB raw. Everything a form
   asks only when it says so is a part loaded on demand, and the public loader fetches it before the form mounts
   (FormSurface.tsx formArrives): the stepper and its parts (MultiStepForm, FormParts), the intake sheets, the draft's
   logic (commandDraft.ts and the condition compiler in formValues.ts, for a `when` or a rule), the live lines and
   the expression parser they read with (CommandLive, computedParse.ts), the server's step check (formStepCheck.ts)
   and the new controls (IntakeControls). Two of those had reached the first paint by the bundler's own rule — what
   a part loaded on demand uses of a module the first page reaches is drawn into the first page's chunk — so the
   declaration parser takes the condition compiler as an argument (command.ts, commandInputParse.ts) and the
   expression parser is a module of its own (computedParse.ts). The coarse-pointer and contrast rules
   (preferences.css) are every page's, as touch targets must be. Measured: public script 637,511 / 181,014, style
   374,959 / 50,075; App script 1,355,983 / 374,640, style 375,924 / 50,418. The script ceilings keep the room the
   base had (public about 340 bytes, App raw about 400).
   rc.1's forms wave 3 (the public doors, the quiet form and the proof Apps' forms), measured together after the
   three branches met. What a first paint must draw at once: the landing hero's badge, photo tiles and icon rows
   (LandingSurface.tsx, their boxes sized before the photos arrive), whose rules are the public page's own sheet
   (landingHero.css, the public chunk's, fetched by a member whose home is the landing with its answer,
   PublicHome.tsx); the guard's seam in FormSurface.tsx (the human check, its widget and the decoy are one part
   loaded on demand, PublicGuard.tsx, as are the App's input components and a page's door); the review's summaries
   with a Change that opens a step in place and says a date in the reader's locale (reviewValues.ts); the quiet form
   on every form that runs a command or makes a record (formDress.css, the stepper's review and phone foot in
   FormSurface.css), in the first paint because a field dressed by a sheet fetched after it would repaint from edged
   to well as it landed; and the form's primary-action color (`primary` in the palettes, worn by appTheme.js, the
   words on it chosen by themePresets.ts). Measured: public script 640,399 / 181,654 (+2,888 / +640 over the base
   above), style 380,929 / 51,020 (+5,970 / +945, the hero's sheet and formDress.css; two sheets compress worse than
   one); App script 1,359,664 / 375,469 (+3,681 / +829), style 380,810 / 50,991 (+4,886 / +573, formDress.css).
   Each ceiling is its measure with about 150-300 bytes of room raw and 50-100 in brotli.
   The pre-rc.1 fixes drawn on every shell page: a breakdown bar wearing its group's tone (four small rules, the bar
   being first-paint markup), a full-screen dialog without a theme's edge, and the grid's hover title reading a line
   the cell clips inside itself (Grid.tsx). Public style 375,265 and App style 376,230 raw, App script 1,356,421: 165,
   130 and 21 bytes past; the three raw ceilings move by that and about 150 bytes, brotli stays inside.
   The image fixes: a picture's `<img>` fallback names its format (`imageFallbackSet`, `&f=fallback`), one small function
   the public page's cards, gallery and landing share. Public script raw moves by about 200 bytes; brotli stays inside.
   rc.1's forms follow-up adds to every form's first paint what a field draws as it arrives: the valid check's box
   and its judging of an answer by the field's own rules (CommandFields.tsx, the reader it uses was already there), a
   consent's statement drawn without its label beside it, the review's "Label: value" lines for a group
   (reviewValues.ts), the description said on the first step only (FormSurface.tsx), a public page command's served
   choices (sdk/commands.tsx), and the label row as one run of text with the mark's room (forms.css, formDress.css).
   The cards, the slider's ends and the grouped amount ride IntakeControls, a part loaded on demand. Measured: public
   script 642,170 / 182,089 (+1,520 / +339 over the ceiling above), style 381,269 / 51,106; App script 1,361,737 /
   376,079 (+1,837 / +529), style 381,150 / 51,077. The ceilings keep the same room.
   The two met (rc/rc1-rest's pre-rc.1 and image fixes on top of rc/forms-followup), measured together: rc1-rest's
   `<picture>` sources and `&f=fallback` sets on the landing, cards and gallery, the toned breakdown bar, the
   full-screen dialog's edge and the grid's clipped-line title, over the forms follow-up's valid check, review lines
   and label row. Public script 642,513 / 182,214 (+343 / +125 over the follow-up's measure), style 381,597 / 51,111
   (+328 / +5); App script 1,362,097 / 376,121 (+360 / +42), style 381,478 / 51,082 (+328 / +5). Each ceiling the
   two passed keeps the follow-up's room (about 200 raw, 60-70 in brotli); the App script's brotli ceiling, which
   rc1-rest carried from before the first merge, comes back down to its measure and the same room.
   Under load, a session check that got no answer is asked once more after a short pause before the App is locked as
   unavailable (sessionLifecycle.ts, every first page's, since the check runs before anything is fetched on demand),
   and a change heard while a read is out waits for that read and asks once more (recordWriteRefresh.ts, the shell's
   refresh after every write); the public page also sends its link's `?via=` with a form's read (publicForm.js).
   Measured: public script 641,398 / 181,884 (+999 / +230), App script 1,361,558 / 375,906 (+1,894 / +437); styles
   unchanged. The script ceilings move by that, keeping about 250 bytes of room raw and 100 in brotli.
   The three met (rc/tenant-live on top of rc/rc1-rest and rc/forms-followup), measured together: tenant-live's session
   check asked again and the refresh that waits for a read out (both scripts), over the two before; and the New form's
   optional word given its space in formDress.css, every form's first paint, since a record's New form draws no Field
   and so never fetches forms.css (both styles). Public script 643,506 / 182,499 (+993 / +285 over the two's measure),
   style 381,742 / 51,195 (+145 / +84); App script 1,364,050 / 376,806 (+1,953 / +685), style 381,623 / 51,166
   (+145 / +84). Each ceiling keeps about 200-250 bytes of room raw and 75-100 in brotli.
   rc.1's intake-desk pass adds to every stepped form's first paint the one step indicator and, at a desk, the steps
   beside a page (MultiStepForm.tsx; the list's layout in structure.css and its dress in features.css, in the first
   frame so nothing moves when it shows), short cards two or three to a row (cardFit in IntakeControls, CheckCards'
   `fit`), the review as answers with an unanswered optional left out (FormSurface.tsx, SavedFormSurface.tsx,
   reviewValues.ts, the review's rules now FormSurface.css's for both styles), the quiet outline's labels, section
   room and 16px caret (formDress.css, forms.css), a hero's icon rows beside its words (LandingSurface), the receipt's
   way back and the brand row's name, and a record form's rows (structure.css, drawn there because a New form of
   plain boxes never fetches forms.css). The kit's sheets are the Workbench's too. Measured: public script 643,990 /
   182,671 (+1,820 / +582), style 387,557 / 52,045 (+6,288 / +939); App script 1,363,443 / 376,583 (+1,706 / +504),
   style 387,438 / 52,016 (+6,288 / +939); Workbench style 372,760 / 50,812 (its brotli ceiling moves). The ceilings
   keep the same room.
   The four met (rc/intake-desk on top of the three), measured together: intake-desk's step indicator, step column,
   card grid, review rows, outline and record-form rows over the three's session check, refresh and pictures; the New
   form's optional word now has its space in the markup (NewRecord.tsx), so formDress.css's rule for it is gone.
   Public script 645,326 / 182,991, style 387,885 / 52,109; App script 1,365,982 / 377,167, style 387,766 / 52,080;
   Workbench style 373,088 / 50,875. Each ceiling keeps about 200-250 bytes of room raw and 75-100 in brotli.
   rc.1's consistency pass, read off the surface atlas: a form of plain boxes (a public form, a command page) says its
   optional word after a space, so the label row's rules leave forms.css, which such a form never fetches, for
   primitives.css; a command form's amount carries its sign inside the box (IntakeControls.css); the sign-in door, a
   prompt and the account profile fill their one action in the primary-action color (features.css); a landing grows
   on a wide desk (LandingSurface.css). The kit's sheets are the Workbench's too. Measured: public style 388,531 /
   52,186 (+646 / +77), App style 388,412 / 52,157 (+646 / +77), Workbench style 373,734 / 51,033 (+646 / +158);
   scripts unchanged. The style ceilings move by that and keep the same room.
   The final merge (rc/merge3, rc/split and the consistency pass together), measured: public script 645,332 /
   183,021, App script 1,365,988 / 377,279, styles as the consistency pass measured them. The App script's brotli grew
   112 bytes for 6 raw: the consistency pass's money sign (IntakeControls.tsx) beside merge #3's last edits compress a
   little worse together than apart. Its brotli ceiling moves by that and keeps about 100 bytes of room.
   One write's refresh (rc/storm): the page tells its own writes apart from others' (ownWrites.ts, which core.js
   marks each write with, so it rides every surface core.js does), and a tenant read, a batched count and a breakdown
   file the tables they read (tenantTransport.ts, liveReads.ts sameReads), so a change asks again only what it
   touched. A field report was 65 to 112 requests after one write. Measured: public script 645,937 / 183,140
   (+605 / +119), App script 1,366,650 / 377,326 (+662 / +47). The script ceilings move by that and keep about 200
   bytes of room raw and 100 in brotli.
   One primary-action color (docs/design.md): the primary fills read `--primary` beside the accent in six rules (page.css,
   lumenLook.css, themeFamilies.css, LandingSurface.css, ListEmpty.css), about 200 raw bytes in the first paint's style;
   its raw ceilings move by 250 and keep the room they had.
   rc/split merged into rc/storm, measured: App script 1,366,650 / 377,455, the raw as rc/storm alone had it and the
   brotli 129 bytes more, the same bytes compressing a little worse beside rc/split's edits. Its brotli ceiling moves
   by 125 and keeps about 100 bytes of room. */
export const BUDGET = {
  /* The clean break's rename (tablewalk.* keys, events and component ids became mistri.*) changed no behavior and
     shortened the raw script, but brotli packs the new spellings 100 to 150 bytes worse on the public and App first
     paints: their brotli ceilings rose 250 bytes, to 183_325 and 377_625. */
  mistri: {
    /* rc/cleanbreak merged into rc/storm, measured: public script 645,789 raw / 183,153 brotli, App script 1,366,417 /
       377,540 — the rename's shorter raw beside rc/storm's live-refresh client, which the clean break's raw ceilings
       (645_550, 1_366_200) did not carry. The raw ceilings sit about 250 bytes above the merge; the brotli ceilings are
       the clean break's. */
    public: { script: { raw: 646_050, br: 183_325 }, style: { raw: 389_000, br: 52_275 } },
    /* A one-click command's revision asked as the pointer or focus reaches its button (commandSend.ts readyCommand,
       Actions.tsx), so the click sends only the execute: about 500 raw bytes, 1335.1 KiB measured. The App script's
       raw ceiling moves to 1_367_400 and keeps about 250 bytes of room; its brotli did not move past its ceiling. */
    /* The @mistriwork scope: the longer package specifiers the client names (docs strings, scaffolds) pack about 200
       bytes worse in brotli on the App first paint, 369.0 KiB measured; its brotli ceiling moved to 378_000.
       rc/s5 (one mistri schema on PostgreSQL) merged after it, measured: App script 1,367,214 / 377,712, 144 bytes
       under the rename's figure in brotli. The brotli ceiling comes back to 377_825, about 100 bytes of room, as the
       other ceilings keep. */
    app: { script: { raw: 1_367_400, br: 377_825 }, style: { raw: 388_900, br: 52_250 } },
  },
  tablewalk: {
    workbench: { script: { raw: 1_287_900, br: 361_400 }, style: { raw: 375_300, br: 51_125 } },
  },
};

/* @mistriwork/mistri/react, measured without React and the routers (the host's) and in brotli as this script compresses it:
   the package's files are a host bundler's input, not served as they are, so they carry no .br of their own.
   `provider` is what a host's page pays for importing @mistriwork/mistri/react at all — the entry, its Provider and
   elements, the navigator, the session and the protocol check — and is held small on purpose: the shell is a chunk
   of its own, loaded by an effect the first time an element is on screen. `adapter` is the largest router adapter
   with what it imports (the navigator). `shell` is that chunk with its static imports: the served client's shell,
   built once more with the embed's seams and its stylesheets as scoped text (vite.embed.config.ts). It is library
   output, whose whitespace Vite leaves for the host's minifier, so its raw size is larger than the served
   client's for the same code; what loads after it is the same split into parts loaded on demand as when served.
   The first measure, when @mistriwork/mistri/react arrived: provider 13,112 / 4,678, adapter 3,452 / 1,332, shell 514,833 /
   80,881; the ceilings sit about 1.5% above.
   0.9.0's embed boots with one read: the host's authorization and the address the shell opens at travel in the
   provider's first request (session.ts, shared/mount.ts, the protocol's version check in embedProtocol.ts), so a
   host's page asks once rather than once for the session and again when the shell loads. Moving that behind the
   shell chunk would add the round trip back. Provider 14,561 / 5,134; its ceiling moves to 14,800 / 5,250.
   The Lumen refresh's shell code (the sticky head, held tab counts, the set-cents rule) is the served shell's too:
   shell 521,080 / 82,109, its brotli ceiling moves to 82,400. The gap fixes' row opens and one-click commands
   are the shell's as well: 522,956 / 82,440, and the ceiling moves to 523,400 / 82,600. 0.9.2's theme wave B
   (the menu's colors, the pill and control tokens, the heading and lane recipes) is the shell's stylesheet too:
   517.3 / 81.4 KiB, and the ceiling moves to 531,300 / 83,600. Wave F's metric figure and gallery button are the
   shell's as well: 518.9 / 81.7 KiB, and the ceiling moves to 532,900 / 83,900. 0.9.5's theme and page work is the
   shell's too (see BUDGET): 550.6 / 83.9 KiB, and the ceiling moves to 565,600 / 86,200. Its design pass is the shell's as well: 572.0 / 85.9 KiB,
   and the ceiling moves to 587,500 / 88,300. 0.9.6's layout pass is the shell's stylesheet too: 575.4 KiB raw, and the
   raw ceiling moves to 591,000. With 0.9.6's robustness wave beside it (the tenant read's retry, the command's one
   refresh) it is 576.3 / 86.4 KiB, and the brotli ceiling moves to 88,900. 0.9.6's states pass (see BUDGET) is the
   shell's too: 577.4 KiB raw, and the raw ceiling moves to 593,000.
   refresh) it is 576.3 / 86.4 KiB, and the brotli ceiling moves to 88,900. Its phone pass is the shell's as well
   (see BUDGET): 578.7 KiB raw, and the raw ceiling moves to 594,400. */
export const EMBED_BUDGET = {
  provider: { raw: 14_800, br: 5_250 },
  /* 0.9.9: the navigator reaches core.js, which now files each read's tables (liveReads.ts): 3,529 / 1,363. */
  adapter: { raw: 3_600, br: 1_400 },
  shell: { raw: 594_400, br: 88_900 },
};

/* The chrome's words in a language besides English (vite.config.ts LOCALE_GROUP, src/client/copy/<lang>.ts), one chunk
   each, which only a reader of that language fetches — preloaded beside the entry (clientSurface.ts localePreloads).
   English stays in the entry, so these are no surface's first paint; each is held on its own instead, so a language
   cannot grow into a second catalog unnoticed. First measure, the shared words only (Spanish): 2,453 / 881. */
export const LOCALE_BUDGET = { raw: 4_000, br: 1_600 };

/** Each language's words chunk in one binary's client, raw and in brotli. */
export function localeSizes(client = CLIENTS.mistri) {
  const sizes = {};
  for (const file of readdirSync(join(client, 'assets'))) {
    const language = /^copy\.([a-z]{2,3})-[\w-]+\.js$/.exec(file)?.[1];
    if (!language) continue;
    const bytes = readFileSync(join(client, 'assets', file));
    sizes[language] = { raw: bytes.length, br: brotliCompressSync(bytes).length };
  }
  return sizes;
}

/** A file and everything it imports statically, as the library build writes imports (`from "./x.js"`). */
function staticClosure(roots) {
  const files = new Set();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const [, path] of readFileSync(file, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*"(\.\.?\/[^"]+\.js)"/g)) {
      pending.push(join(dirname(file), path));
    }
  }
  return [...files];
}

/** @mistriwork/mistri/react's three measures, raw and in brotli. */
export function embedSizes(embed = EMBED) {
  const measure = (files) =>
    files.reduce(
      (sum, file) => {
        const bytes = readFileSync(file);
        return { raw: sum.raw + bytes.length, br: sum.br + brotliCompressSync(bytes).length };
      },
      { raw: 0, br: 0 },
    );
  const shell = readdirSync(join(embed, 'chunks')).find((file) => /^shell-[\w-]{8}\.js$/.test(file));
  if (!shell) throw new Error('The embed build has no shell chunk.');
  const adapters = ['next', 'react-router', 'tanstack-router'].map((name) => measure(staticClosure([join(embed, `${name}.js`)])));
  return {
    provider: measure(staticClosure([join(embed, 'index.js')])),
    adapter: adapters.reduce((largest, next) => (next.br > largest.br ? next : largest)),
    shell: measure(staticClosure([join(embed, 'chunks', shell)])),
  };
}

/**
 * The files under dist/embed that still call require(), each with the first
 * call in it. vite.embed.config.ts says why there must be none, and how there
 * came to be one: a CommonJS dependency's `require("react")` that
 * esmExternalRequirePlugin did not rewrite, left to rolldown's runtime shim
 * (`typeof require` and its "doesn't expose the `require` function" throw).
 */
export function embedRequires(embed = dirname(EMBED)) {
  const call = /(?<![\w$.])require\s*\(|typeof require\b/;
  /** @type {Array<{ file: string, excerpt: string }>} */
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.m?js$/.test(name)) {
        const text = readFileSync(path, 'utf8');
        const at = text.search(call);
        if (at >= 0) found.push({ file: path.slice(ROOT.length + 1), excerpt: text.slice(Math.max(0, at - 40), at + 40) });
      }
    }
  };
  walk(embed);
  return found;
}

/** Each surface's first page, the binary whose client it is, and the chunks past it that it loads at once. Each
    page names its own (vite.config.ts PAGES): an App's preloads the shell with the App's chrome, the Workbench's the
    kit's shell with the database browser's main, in the workbench chunk. */
export const SURFACES = {
  public: { bin: 'mistri', page: 'index.public.html', chunks: [] },
  app: { bin: 'mistri', page: 'index.html', chunks: [] },
  workbench: { bin: 'tablewalk', page: 'index.workbench.html', chunks: [] },
};
/** A surface's ceilings: its binary's. */
export const ceilingOf = (surface) => BUDGET[SURFACES[surface].bin][surface];

/**
 * A first visit's files: the page's entry, the chunks it preloads and any
 * named here, what they import statically, and the page's stylesheets.
 * @param {keyof typeof SURFACES} surface
 */
export function firstPaint(surface = 'app', client = CLIENTS[SURFACES[surface].bin]) {
  const { page, chunks } = SURFACES[surface];
  const html = readFileSync(join(client, page), 'utf8');
  const local = (path) => join(client, path.replace(/^\//, ''));
  const scripts = new Set();
  const pending = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => local(match[1]));
  pending.push(...[...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => local(match[1])));
  const assets = readdirSync(join(client, 'assets'));
  for (const name of chunks) {
    const file = assets.find((file) => new RegExp(`^${name}-[\\w-]{8}\\.js$`).test(file));
    if (!file) throw new Error(`The build has no ${name} chunk.`);
    pending.push(join(client, 'assets', file));
  }
  while (pending.length) {
    const file = pending.pop();
    if (scripts.has(file)) continue;
    scripts.add(file);
    /* Static imports only, as the minifier writes them (`from"./x.js"`,
       `import"./x.js"`); `import("./x.js")` is a part loaded on demand. */
    for (const [, path] of readFileSync(file, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*"(\.\/[^"]+\.js)"/g)) {
      pending.push(join(dirname(file), path));
    }
  }
  const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => local(match[1]));
  const measure = (files) =>
    files.reduce(
      (sum, file) => ({
        raw: sum.raw + statSync(file).size,
        br: sum.br + (existsSync(`${file}.br`) ? statSync(`${file}.br`) : statSync(file)).size,
      }),
      { raw: 0, br: 0 },
    );
  return { scripts: [...scripts], styles, script: measure([...scripts]), style: measure(styles) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [bin, client] of Object.entries(CLIENTS))
    if (!existsSync(join(client, 'index.html'))) {
      console.error(`Build the client first: npm run build (${bin}'s is missing).`);
      process.exit(1);
    }
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
  const over = [];
  for (const surface of /** @type {Array<keyof typeof SURFACES>} */ (Object.keys(SURFACES))) {
    const shipped = firstPaint(surface);
    for (const kind of ['script', 'style']) {
      for (const measure of ['raw', 'br']) {
        const size = shipped[kind][measure],
          ceiling = ceilingOf(surface)[kind][measure];
        console.log(`${SURFACES[surface].bin} ${surface} ${kind} ${measure}: ${kb(size)} of ${kb(ceiling)}`);
        if (size > ceiling)
          over.push(
            `the ${surface} first paint's ${kind} is ${kb(size)} ${measure === 'br' ? 'in brotli' : 'raw'}, over its ${kb(ceiling)} ceiling`,
          );
      }
    }
  }
  for (const [bin, client] of Object.entries(CLIENTS))
    for (const [language, sizes] of Object.entries(localeSizes(client))) {
      for (const measure of /** @type {const} */ (['raw', 'br'])) {
        console.log(`${bin} words ${language} ${measure}: ${kb(sizes[measure])} of ${kb(LOCALE_BUDGET[measure])}`);
        if (sizes[measure] > LOCALE_BUDGET[measure])
          over.push(
            `${bin}'s ${language} words are ${kb(sizes[measure])} ${measure === 'br' ? 'in brotli' : 'raw'}, over their ${kb(LOCALE_BUDGET[measure])} ceiling`,
          );
      }
    }
  if (!existsSync(join(EMBED, 'index.js'))) {
    console.error('Build @mistriwork/mistri/react first: npm run build.');
    process.exit(1);
  }
  const embedded = embedSizes();
  for (const part of /** @type {Array<keyof typeof EMBED_BUDGET>} */ (Object.keys(EMBED_BUDGET))) {
    for (const measure of /** @type {const} */ (['raw', 'br'])) {
      const size = embedded[part][measure],
        ceiling = EMBED_BUDGET[part][measure];
      console.log(`@mistriwork/mistri/react ${part} ${measure}: ${kb(size)} of ${kb(ceiling)}`);
      if (size > ceiling)
        over.push(
          `@mistriwork/mistri/react's ${part} is ${kb(size)} ${measure === 'br' ? 'in brotli' : 'raw'}, over its ${kb(ceiling)} ceiling`,
        );
    }
  }
  const requires = embedRequires();
  for (const { file, excerpt } of requires) console.error(`${file} calls require(): …${excerpt.replace(/\s+/g, ' ')}…`);
  if (requires.length) {
    console.error(
      '@mistriwork/mistri/react must hold no require(): no browser or ESM host provides one. A CommonJS dependency reaching React is rewritten by esmExternalRequirePlugin in vite.embed.config.ts, which must be the only place those specifiers are made external.',
    );
    process.exitCode = 1;
  }
  if (over.length && !process.argv.includes('--print')) {
    console.error(
      `Bundle budget: ${over.join('; ')}. Move the new weight behind components/onDemand.tsx, or raise the ceiling in scripts/bundle-budget.mjs and say why.`,
    );
    process.exitCode = 1;
  }
}
