/**
 * Deep links: the pure half.
 *
 * No DOM and no state, so it can be tested directly. The stateful half —
 * reading `window.location`, deciding when to write it — lives in url.js.
 *
 * The design decision that matters: **the trail goes in the URL, not just the
 * current position.** A link to a row you reached by walking should arrive
 * with the walk intact, so whoever you send it to can go back the way you
 * came. That is the tool's whole idea, and a link that dropped it would hand
 * them a dead end.
 *
 * The hash is used rather than the path because tablewalk serves a static
 * client from a small server with no router. A path-based URL would need the
 * server to know every route; a hash never reaches it.
 *
 * Compactness matters, because these get pasted into chat. A table view is
 * its query text, already short and human-readable; a row is its key:
 *
 *   /demo/customer/~4/invoice%20customer_id%20=%204/~1004
 */

/** A table view. Mirrors core.js — kept here so this module imports nothing. */
/* The tabs a table view can be on — see the tab strip in table.js — and
   `new`, which is not a tab of the grid but the app's New drawer open over
   the list; it rides the same slot so a half-filled form survives a reload.
   A segment ends in one of these or it does not end in a tab at all. */
const TABS = new Set(['rows', 'ddl', 'api', 'diagram', 'new']);
/* A composer session is a tab too (composerTab.js): a bare `view`, a saved
   one as `view:<id>`, an unsaved one as `view+<its text, encoded>`. */
const isTableTab = (suffix) => TABS.has(suffix) || suffix === 'view' || /^view[:+]./.test(suffix);

/**
 * A query, safe to put after a `!` separator.
 *
 * `encodeURIComponent` leaves `!` alone — it is an unreserved character — so
 * a query containing `!=` wrote a second separator into its own segment.
 */
function encodeQuery(query) {
  return encodeURIComponent(query).replace(/!/g, '%21');
}

/**
 * A key, as it appears in a link.
 *
 * Single-column keys — nearly all of them — are just the value, so the common
 * case stays readable; composite keys name their columns, because position
 * alone would not survive a column being added.
 *
 * Shared by rows and pages so the two cannot spell the same key differently.
 */
function keyBody(key) {
  const columns = Object.keys(key);
  return columns.length === 1 ? String(key[columns[0]]) : columns.map((c) => `${c}=${key[c]}`).join(',');
}

function tableView(tableId, query, tab, view) {
  return { kind: 'table', table: tableId, query: query ?? tableId, tab: tab ?? 'rows', ...(view ? { view } : {}) };
}

/* A view's key — the letters a view key allows. Only these ride a
   link as `{id}:` before a list's question, which keeps the prefix
   decidable: an encoded query never carries a raw `:`, and no table's name
   is followed by one. */
const VIEW_KEY = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Serialise a connection id and a stack into a hash.
 *
 * `pageToken` turns a page's id into the text a link should carry — its name,
 * where that names it unambiguously. Passed in rather than imported: this
 * module deliberately depends on nothing, which is what lets the link format
 * be tested without a browser, and the page list it would need to consult
 * lives three modules away. The default writes the id, which is what every
 * link did before and still resolves.
 *
 * `listParams` says a list one of the App's views opened in words — its key,
 * its question as the address's parameters (publicAddress.ts) — and answers
 * undefined for a list it cannot say that way, which is written as ever. The
 * default says none, which is what the Workbench writes.
 */
export function hashFor(connectionId, stack, options = {}) {
  const pageToken = options.pageToken ?? ((id) => id);
  const listParams = options.listParams ?? (() => undefined);
  const parts = [encodeURIComponent(connectionId ?? '')];
  /* The lists said in words, and the one whose parameters are the search:
     an address has one search, so it is the last such list's, and an earlier
     list is said in words only where it stands as authored. */
  const said = stack.map((entry) => (entry.kind === 'table' && VIEW_KEY.test(entry.view ?? '') ? listParams(entry) : undefined));
  let asks = -1;
  said.forEach((params, index) => {
    if (params !== undefined) asks = index;
  });
  let search = '';
  stack.forEach((entry, index) => {
    if (entry.kind === 'page') {
      /* `@page-id` for the page, and the root — when one has been chosen —
         written exactly as a row's key is, so the two agree about composite
         keys instead of inventing a second spelling for them. A page with no
         root is a link to the front door, which is a real place to send
         someone: "open the customer page and pick one". */
      /* `rootBody` is the unresolved form a link arrives with, and it is
         written back when the key has not been resolved yet. Boot renders —
         and stamps the hash — before the page has looked up which column a
         bare key belongs to, so without this the first paint dropped the root
         out of the address bar and the reader lost it by reloading. */
      const body = entry.key ? keyBody(entry.key) : (entry.rootBody ?? '');
      /* The open tab rides with the page rather than after the key: a key is
         arbitrary text and may contain a `!`, while a page token is a slug or
         an id and never does. "Look at the parts tab" is a thing people send
         each other, and a link that always lands on the first tab loses the
         point of sending it. */
      const tab = entry.tab ? `!${encodeURIComponent(entry.tab)}` : '';
      parts.push(`@${encodeURIComponent(pageToken(entry.pageId))}${tab}${body ? `~${encodeURIComponent(body)}` : ''}`);
      return;
    }
    if (entry.kind === 'table' || entry.kind === 'breakdown') {
      /* A list in words: its key — `/thread/board`, the New drawer after it
         as ever, `/crm/leads!new` — and its question in the search. */
      const params = said[index];
      if (params !== undefined && (index === asks || params === '')) {
        const suffix = entry.tab && entry.tab !== 'rows' ? `!${entry.tab}` : '';
        parts.push(`${entry.view}${suffix}`);
        if (index === asks) search = params;
        return;
      }
      /* A breakdown carries no tab — it has none — and is otherwise the same
         segment as a table query, because it is the same language. Which kind
         it comes back as is decided by `isBreakdown` in `fromHash`. */
      const tab = entry.kind === 'table' && entry.tab && entry.tab !== 'rows' ? `!${entry.tab}` : '';
      /* Which of the App's views opened the list, by its key: `inbox:issue…`.
         Two views over one table — a plain list and a split — ask the same
         question of the same rows, so the text alone cannot say which room
         to draw. A row after it inherits the view and writes nothing.
         Absent, the view is found by table and query, as every link written
         before keys existed still is. */
      const view = entry.kind === 'table' && VIEW_KEY.test(entry.view ?? '') ? `${entry.view}:` : '';
      parts.push(view + encodeQuery(entry.query) + tab);
    } else {
      /* A row is `~` plus its key. Single-column keys — nearly all of them —
         are just the value, so the common case stays readable; composite keys
         name their columns because position alone would not survive a schema
         change.

         The table is named whenever it differs from the entry before, which
         is exactly what following a foreign key from one row to another does.
         Without it `work_order/~8/~636` claims 636 is a work_order when it is
         a customer, and the link restores the wrong row — or no row. */
      const body = keyBody(entry.key);
      const previous = stack[index - 1];
      const prefix = previous && previous.table === entry.table ? '' : `${entry.table}:`;
      /* And which related table is open, if one is — the record view's rail
         is a tablist, and "look at its notes" is as worth linking to on a
         record as it is on a page. `!` is escaped inside the key for the
         same reason the query encoder escapes it: it is an unreserved
         character that `encodeURIComponent` leaves alone, so a value
         containing one would otherwise write a second separator. */
      const tab = entry.tab ? `!${encodeURIComponent(entry.tab)}` : '';
      parts.push(`~${encodeQuery(prefix + body)}${tab}`);
    }
  });
  return `/${parts.join('/')}${search ? `?${search}` : ''}`;
}

/**
 * The address a public visitor sees: the one thing on screen, not the walk
 * that reached it.
 *
 * The walk is the tool's idea of a link, and it is right for the people who
 * work in it; a marketplace's visitor shares a car, and a car's address that
 * carried `vehicles:vehicle status != sold and body_type = Sedan show title,
 * price…` before it leaked the list's plumbing into every message it was
 * pasted in. So a page is its own segment alone, and a list the App names is
 * its view key with its question as address parameters — `listParams`
 * returns them, '' for the view as it stands, or undefined when the question
 * cannot be said that way, and then the list is written as ever — hashFor's
 * words, for a walk of one. The walk itself rides in history state (url.js),
 * so Back and the crumbs still know it.
 */
export function publicPathFor(connectionId, stack, options = {}) {
  const last = stack[stack.length - 1];
  if (!last) return `/${encodeURIComponent(connectionId ?? '')}`;
  return hashFor(connectionId, [last], options);
}

/**
 * The connection a hash names, without parsing the rest of it.
 *
 * Needed because parsing the trail requires the *right* schema: a link into
 * another database mentions tables the current one has never heard of, so
 * every row segment fails to resolve and is dropped. The connection has to be
 * switched before the rest can be read.
 */
/**
 * Take the leading `/` off a link — or the leading `#/` off one written
 * before these were paths.
 *
 * Both spellings are read for as long as it costs one regex to do so. A link
 * is the thing people paste into a ticket and come back to a year later, and
 * the day the old ones stop resolving should not be the day this changed.
 */
function stripPrefix(link) {
  return String(link ?? '')
    .replace(/^#/, '')
    .replace(/^\//, '');
}

/* A segment as the person typed it. A link pasted through a mailer or a linkifier arrives with a lone `%` or a cut
   escape (`%zz`, `%E0%A4%A`), and `decodeURIComponent` throws on those: at boot that stops the App from starting at
   all, and in a click it kills the navigation. The raw segment is returned instead, which names nothing and so lands on
   the same not-found as any other address nobody made. */
function unescapeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function connectionFromHash(hash) {
  // A public list's address carries its question after `?`; the connection is before it.
  const raw = stripPrefix(hash).split('?')[0];
  if (!raw) return null;
  const first = raw.split('/').filter(Boolean)[0];
  return first ? unescapeSegment(first) : null;
}

/**
 * Parse a hash into a stack. Returns null when there is nothing to restore.
 *
 * Rows need the table they belong to, which is the entry before them — so a
 * row segment that opens the trail is dropped rather than guessed at.
 */
export function fromHash(hash, findTableById, options = {}) {
  /* Read off `options` rather than destructured with a default in the
     signature: `check-client-imports` cannot see a parameter list once a
     default inside it has parentheses of its own, and reads every name in it
     as undefined. The tool is right that this file must import nothing, so it
     is the signature that gives way. */
  const isBreakdown = options.isBreakdown ?? (() => false);
  /* A view the App names, as a public address spells it — its key, its
     question as parameters — is resolved by the caller, which knows the
     App's views: this module imports nothing. */
  const viewEntry = options.viewEntry ?? (() => null);
  const [raw, search = ''] = stripPrefix(hash).split(/\?(.*)/s);
  if (!raw) return null;
  const segments = raw.split('/').filter(Boolean);
  if (!segments.length) return null;

  const connection = unescapeSegment(segments[0]);
  const stack = [];
  /* A bare view key — a list said in words, its key and the New drawer if
     it is open — is the caller's to read. A table of that name wins, so no
     link written before this means something new. The search is the last
     such list's, as hashFor writes it. */
  const bareView = (segment) => {
    const m = /^([a-z0-9][a-z0-9-]*)(?:!([a-z]+))?$/.exec(segment);
    return m && !findTableById(m[1]) && (!m[2] || TABS.has(m[2])) ? { key: m[1], tab: m[2] } : null;
  };
  let asked = -1;
  segments.forEach((segment, index) => {
    if (index > 0 && bareView(segment)) asked = index;
  });

  for (let index = 1; index < segments.length; index += 1) {
    let segment = segments[index];
    if (segment.startsWith('@')) {
      /* A page, and its root if the link has one. The base table is not in
         the link: a page names it, and putting it in the URL as well would be
         a second copy to disagree with the config file the day someone
         re-points a page at another table. It is filled in when the page
         loads. */
      const [head, keyPart] = segment.slice(1).split('~');
      /* Page first, then the tab: split on the first `!`, which a page token
         cannot contain and a tab name is encoded past. */
      const bang = head.indexOf('!');
      const pageId = unescapeSegment(bang === -1 ? head : head.slice(0, bang));
      const tab = bang === -1 ? undefined : unescapeSegment(head.slice(bang + 1)) || undefined;
      if (!pageId) continue;
      const body = keyPart === undefined ? undefined : unescapeSegment(keyPart);
      /* Carried as text, not resolved here. A single-column key is written as
         a bare value, and turning `1181` back into `{ id: 1181 }` needs the
         page's base table — which the link deliberately does not name, since
         the page already does and two copies would disagree the day someone
         re-points it. The page resolves it when it knows its own base. */
      stack.push({ kind: 'page', pageId, table: undefined, rootBody: body, label: body, tab });
      continue;
    }
    if (segment.startsWith('~')) {
      const rest = segment.slice(1);
      const bang = rest.indexOf('!');
      const tab = bang === -1 ? undefined : unescapeSegment(rest.slice(bang + 1)) || undefined;
      let body = unescapeSegment(bang === -1 ? rest : rest.slice(0, bang));
      /* An explicit `table:` prefix wins. It is only written when the table
         changed, so its absence means "same as the entry before". The colon
         is found from the left and only counts before any `=`, so a composite
         key like `a=1,b=2` is never mistaken for a table prefix. */
      let tableId = null;
      const colon = body.indexOf(':');
      if (colon > 0 && (body.indexOf('=') === -1 || colon < body.indexOf('='))) {
        /* Only if it actually names a table. A key value can contain a colon
           — a time like `12:30`, a URN, a namespaced id — and treating that
           as a table prefix would drop the row entirely. Checking against the
           schema makes the ambiguity decidable instead of guessed. */
        const candidate = body.slice(0, colon);
        if (findTableById(candidate)) {
          tableId = candidate;
          body = body.slice(colon + 1);
        }
      }
      const previous = stack[stack.length - 1];
      if (!tableId && !previous) continue; // a row with no table means nothing
      const resolvedId = tableId ?? previous.table;
      const table = findTableById(resolvedId);
      if (!table) continue;
      const key = {};
      if (body.includes('=')) {
        for (const pair of body.split(',')) {
          const [column, ...rest] = pair.split('=');
          key[column] = rest.join('=');
        }
      } else {
        const pk = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
        if (!pk.length) continue;
        key[pk[0]] = body;
      }
      /* A row read beside the list it was chosen from belongs to the same
         view; the link wrote it once, on the list. */
      const inherited = previous?.view && previous.table === table.id ? { view: previous.view } : {};
      stack.push({ kind: 'row', table: table.id, key, label: labelFor(body), tab, ...inherited });
      continue;
    }
    /* A bare view key, as an App's address writes a list: the caller reads
       the address's parameters into the list's question. */
    const bare = bareView(segment);
    if (bare) {
      const entry = viewEntry(bare.key, index === asked ? search : '');
      if (entry) {
        stack.push(bare.tab ? { ...entry, tab: bare.tab } : entry);
        continue;
      }
    }
    /* `{view key}:` before a list's question names the view that opened
       it. Only when what follows starts with a table: a hand-typed query is
       never mistaken for a prefix, the way a row's `table:` is checked. */
    let view;
    const marked = /^([a-z0-9][a-z0-9-]*):(.+)$/.exec(segment);
    if (marked && findTableById(unescapeSegment(marked[2].split('!')[0]).trim().split(/\s+/)[0])) {
      view = marked[1];
      segment = marked[2];
    }
    /* Only a real tab name ends a segment.
    
       `lastIndexOf('!')` alone read the `!` of `!=` as the separator, so
       `invoice total != 0` came back as `invoice total ` with a tab of
       `%3D 0` — the condition silently gone, and a shared "unpaid invoices"
       link showing every invoice. Encoding fixes it going forward; checking
       the suffix against the tabs that exist also rescues every link already
       written and every one this app did not write. */
    const bang = segment.lastIndexOf('!');
    const suffix = bang > 0 ? segment.slice(bang + 1) : '';
    const hasTab = isTableTab(suffix);
    const tab = hasTab ? suffix : 'rows';
    const query = unescapeSegment(hasTab ? segment.slice(0, bang) : segment);
    const name = query.trim().split(/\s+/)[0];
    const table = findTableById(name);
    /* A breakdown is written into the link exactly as a table query is — it is
       the same language and the same text — so which kind it is on the way back
       is read off the text itself. The rule is supplied rather than imported:
       this module deliberately depends on nothing, which is what lets the link
       format be tested without a browser, and it is the same arrangement
       `pageToken` uses on the way out. */
    stack.push(
      isBreakdown(query)
        ? { kind: 'breakdown', table: table ? table.id : name, query }
        : tableView(table ? table.id : name, query, tab, view),
    );
  }

  return { connection, stack };
}

function labelFor(body) {
  // The real label needs the row, which has not been fetched yet. The key is
  // a truthful placeholder and gets replaced by resolveLabels below.
  return body.length > 24 ? `${body.slice(0, 23)}…` : body;
}
