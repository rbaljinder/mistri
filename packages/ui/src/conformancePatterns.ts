/**
 * `checkPatterns(root)`: the WAI-ARIA Authoring Practices patterns, read off a live page. Every listbox, menu, tab
 * list, tree, dialog, combobox, radio group and switch under `root` is held to what its pattern promises a reader —
 *
 *   - its role and an accessible name, and a name on each of its items;
 *   - the roles it must own (a listbox its options, a menu its menu items, a tab list its tabs, a tree its tree items,
 *     a radio group its radios), and nothing it may not;
 *   - one Tab stop for a composite widget, kept by a roving tabindex or by `aria-activedescendant` on a focusable
 *     holder — none inside a popup a combobox drives, since the focus stays in the box;
 *   - the keys the pattern names: the arrows, Home and End move the current item; Escape closes a popup;
 *   - the focus never falls to the body or into inert content, after any of those keys or in an open modal dialog.
 *
 * It answers with the problems it found, each naming the widget, so one run says everything wrong with a page; an
 * empty list is a pass. The keys are pressed the way the conformance suite presses them — dispatched by hand — and a
 * key that changes what is chosen (a tab list's arrows) is walked back afterwards; Escape on an open popup is left
 * closed. A dialog's Escape belongs to whoever opened it, so dialogs are read, not pressed.
 *
 * It is self-contained on purpose — no imports, nothing read from this module's scope — so a browser test can hand the
 * function itself to Playwright's `page.evaluate` and read a real App's page by the rules the unit tests use.
 */

export interface CheckPatternsOptions {
  /** Wraps each key press and the wait after it, so a renderer flushes what it scheduled: pass React's `act` in a unit test. */
  act?: (step: () => Promise<void>) => unknown;
  /** Press keys as well as read roles, names and Tab stops (the default). `false` reads the page without touching it. */
  keys?: boolean;
}

export async function checkPatterns(root?: ParentNode, options?: CheckPatternsOptions): Promise<string[]> {
  const doc: Document = root ? ((root as Node).ownerDocument ?? (root as Document)) : document;
  const scope: ParentNode = root ?? doc;
  const opts = options ?? {};
  const problems: string[] = [];

  /* ---- Reading the page ---- */

  const roleOf = (el: Element): string => {
    const explicit = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0];
    if (explicit) return explicit;
    if (el.tagName === 'DIALOG') return 'dialog';
    if (el.tagName === 'SELECT') return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
    if (el.tagName === 'INPUT') {
      const kind = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (kind === 'radio') return 'radio';
      if (kind !== 'hidden' && el.hasAttribute('list') && /^(text|search|email|tel|url)$/.test(kind)) return 'combobox';
    }
    return '';
  };
  const native = (el: Element) => el.tagName === 'SELECT' || el.tagName === 'INPUT';

  /* What a bare element is to a reader when it names no role: only the few that matter for what a composite may own, so a
     `<button>` set among a listbox's options is seen as the button it is. */
  const implicitRole = (el: Element): string => {
    switch (el.tagName) {
      case 'BUTTON':
        return 'button';
      case 'A':
        return el.hasAttribute('href') ? 'link' : '';
      case 'LI':
        return 'listitem';
      case 'TEXTAREA':
        return 'textbox';
      case 'IMG':
        return el.getAttribute('alt') === '' ? '' : 'img';
      case 'INPUT': {
        const kind = (el.getAttribute('type') ?? 'text').toLowerCase();
        if (kind === 'hidden') return '';
        if (kind === 'checkbox' || kind === 'radio') return kind;
        if (kind === 'button' || kind === 'submit' || kind === 'reset' || kind === 'image') return 'button';
        return kind === 'range' ? 'slider' : 'textbox';
      }
      default:
        return /^H[1-6]$/.test(el.tagName) ? 'heading' : '';
    }
  };

  const hidden = (el: Element): boolean => {
    const view = doc.defaultView;
    for (let at: Element | null = el; at; at = at.parentElement) {
      if ((at as HTMLElement).hidden || at.getAttribute('aria-hidden') === 'true' || at.hasAttribute('inert')) return true;
      if (at.tagName === 'DIALOG' && !at.hasAttribute('open')) return true;
      const style = view?.getComputedStyle(at);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
    }
    return false;
  };

  const words = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  /* The words an element is named by its content: text, a descendant's own aria-label, and nothing under aria-hidden or
     a hidden element, so an item that is only an icon has no name. */
  const contentWords = (el: Element): string => {
    const parts: string[] = [];
    const walk = (node: Node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) parts.push(child.textContent ?? '');
        else if (child.nodeType === 1) {
          const inner = child as Element;
          if (inner.getAttribute('aria-hidden') === 'true' || (inner as HTMLElement).hidden) continue;
          const own = inner.getAttribute('aria-label')?.trim();
          if (own) parts.push(` ${own} `);
          else walk(inner);
        }
      }
    };
    walk(el);
    return parts.join('').replace(/\s+/g, ' ').trim();
  };
  const byIds = (ids: string) =>
    ids
      .split(/\s+/)
      .map((id) => words(doc.getElementById(id)))
      .join(' ')
      .trim();

  /* The name a reader hears: aria-labelledby, aria-label, a label, a title — and the words inside for a role named by
     its content (an option, a tab, a switch). */
  const nameOf = (el: Element, fromContent: boolean): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy && byIds(labelledBy)) return byIds(labelledBy);
    const label = el.getAttribute('aria-label')?.trim();
    if (label) return label;
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return [...labels].map(words).join(' ').trim();
    const title = el.getAttribute('title')?.trim();
    if (fromContent && contentWords(el)) return contentWords(el);
    if (title) return title;
    return el.tagName === 'INPUT' ? ((el as HTMLInputElement).placeholder ?? '').trim() : '';
  };

  const disabled = (el: Element) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
  const tabbable = (el: Element) => (el as HTMLElement).tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !hidden(el);
  const said = (el: Element, role: string) => {
    const name = nameOf(el, false) || nameOf(el, true).slice(0, 40);
    return name ? `${role} "${name}"` : `a ${role}`;
  };

  /* What a container owns: the role-bearing elements under it with nothing but groups between. */
  const THROUGH = new Set(['', 'group', 'presentation', 'none', 'generic']);
  const effectiveRole = (el: Element) => roleOf(el) || implicitRole(el);
  const owned = (container: Element): Element[] =>
    [...container.querySelectorAll('*')].filter((el) => {
      if (!effectiveRole(el) || hidden(el)) return false;
      for (let at = el.parentElement; at && at !== container; at = at.parentElement) if (!THROUGH.has(effectiveRole(at))) return false;
      return true;
    });

  const OWNS: Record<string, { required: string[]; allowed: string[] }> = {
    listbox: { required: ['option'], allowed: ['option', 'group', 'presentation', 'none'] },
    menu: {
      required: ['menuitem', 'menuitemcheckbox', 'menuitemradio'],
      allowed: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group', 'separator', 'presentation', 'none'],
    },
    tablist: { required: ['tab'], allowed: ['tab', 'presentation', 'none'] },
    tree: { required: ['treeitem'], allowed: ['treeitem', 'group', 'presentation', 'none'] },
    radiogroup: { required: ['radio'], allowed: ['radio', 'presentation', 'none', 'group'] },
  };
  const ITEM: Record<string, string> = { listbox: 'option', menu: 'menuitem', tablist: 'tab', tree: 'treeitem', radiogroup: 'radio' };
  const items = (container: Element, role: string) =>
    [...container.querySelectorAll('*')].filter(
      (el) => (roleOf(el) === ITEM[role] || (role === 'menu' && roleOf(el).startsWith('menuitem'))) && !hidden(el),
    );

  /* The element a combobox or a container points at as its current item, or the focused item. */
  const current = (holder: Element, container: Element): Element | null => {
    const id = holder.getAttribute('aria-activedescendant');
    if (id) return doc.getElementById(id);
    const focused = doc.activeElement;
    return focused && container.contains(focused) && focused !== container ? focused : null;
  };

  /* ---- Pressing keys ---- */

  const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const step = async (run: () => void) => {
    const body = async () => {
      run();
      // A popup moves the focus a frame or two after the key.
      await wait(30);
    };
    if (opts.act) await opts.act(body);
    else await body();
  };
  const press = (target: Element, key: string) =>
    step(() => {
      const init = { key, bubbles: true, cancelable: true, composed: true };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
    });
  const focus = (el: Element) => step(() => (el as HTMLElement).focus());
  const focusHolds = (who: string, after: string) => {
    const at = doc.activeElement;
    if (!at || at === doc.body || at === doc.documentElement) problems.push(`${who}: after ${after} the focus fell to the page`);
    else if (at.closest('[inert]')) problems.push(`${who}: after ${after} the focus is inside inert content`);
  };

  /* ---- The widgets ---- */

  const ROLES = new Set(['listbox', 'menu', 'tablist', 'tree', 'dialog', 'alertdialog', 'combobox', 'radiogroup', 'switch']);
  const start: Element[] = scope instanceof Element ? [scope] : [];
  const widgets = [...start, ...scope.querySelectorAll('*')].filter((el) => ROLES.has(roleOf(el)) && !hidden(el));

  /* A popup a combobox drives keeps no Tab stop and is pressed through its box. */
  const driven = new Map<Element, Element>();
  for (const box of widgets.filter((el) => roleOf(el) === 'combobox')) {
    for (const id of `${box.getAttribute('aria-controls') ?? ''} ${box.getAttribute('aria-owns') ?? ''}`.split(/\s+/)) {
      const popup = id ? doc.getElementById(id) : null;
      if (popup) driven.set(popup, box);
    }
  }
  /* A popup is something an expanded trigger names, itself or its frame. */
  const isPopup = (el: Element) =>
    [...doc.querySelectorAll('[aria-expanded="true"][aria-controls]')].some((trigger) =>
      (trigger.getAttribute('aria-controls') ?? '').split(/\s+/).some((id) => {
        const named = id ? doc.getElementById(id) : null;
        return named !== null && named.contains(el);
      }),
    ) || roleOf(el) === 'menu';

  for (const el of widgets) {
    const role = roleOf(el);
    const who = said(el, role);
    // Every one of these patterns has a name; a switch takes its from its words.
    if (!nameOf(el, role === 'switch')) problems.push(`${who}: has no accessible name`);
    if (native(el)) continue;

    if (OWNS[role]) {
      const { required, allowed } = OWNS[role];
      const children = owned(el);
      for (const child of children)
        if (!allowed.includes(effectiveRole(child))) problems.push(`${who}: owns a ${effectiveRole(child)}, which a ${role} may not hold`);
      if (el.getAttribute('aria-busy') !== 'true' && !items(el, role).some((item) => required.includes(roleOf(item))))
        problems.push(`${who}: owns no ${required[0]}`);
      for (const item of items(el, role)) if (!nameOf(item, true)) problems.push(`${who}: an ${roleOf(item)} has no name`);

      const stops = [...el.querySelectorAll('*'), el].filter(tabbable);
      // Native radios of one name are one stop between them.
      const seen = new Set<string>();
      const count = stops.filter((stop) => {
        if (stop.tagName !== 'INPUT' || (stop as HTMLInputElement).type !== 'radio' || !(stop as HTMLInputElement).name) return true;
        const name = (stop as HTMLInputElement).name;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      }).length;
      if (driven.has(el)) {
        if (count > 0) problems.push(`${who}: a popup its combobox drives holds ${count} Tab stop(s); the focus belongs in the box`);
      } else if (role === 'menu' || isPopup(el)) {
        if (count > 1) problems.push(`${who}: holds ${count} Tab stops, not one`);
      } else if (count !== 1) problems.push(`${who}: holds ${count} Tab stops, not one`);
      if (el.hasAttribute('aria-activedescendant') && !tabbable(el) && doc.activeElement !== el)
        problems.push(`${who}: points at its current item with aria-activedescendant but cannot take the focus`);
    }

    if (role === 'combobox') {
      const expanded = el.getAttribute('aria-expanded') === 'true';
      const ids = `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.trim();
      const popups = ids ? ids.split(/\s+/).map((id) => doc.getElementById(id)) : [];
      if (expanded && !popups.some((popup) => popup && /^(listbox|tree|grid|dialog)$/.test(roleOf(popup))))
        problems.push(`${who}: is expanded but controls no listbox, tree, grid or dialog`);
      const active = el.getAttribute('aria-activedescendant');
      if (active && !doc.getElementById(active)) problems.push(`${who}: aria-activedescendant names "${active}", which is not on the page`);
      if (disabled(el) === false && !tabbable(el)) problems.push(`${who}: is not a Tab stop`);
    }

    if (role === 'switch') {
      const checked = el.getAttribute('aria-checked');
      if (checked !== 'true' && checked !== 'false' && !(el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox'))
        problems.push(`${who}: does not say whether it is on (aria-checked)`);
    }
  }

  /* The topmost modal dialog holds the focus. Topmost is the one stacked highest — the largest z-index on it or an
     ancestor — and among equals the one later in the document, which is where a layer opened last is drawn (a portal
     appends; a dialog nested in another comes after it). A page that stacks by neither is not told it is wrong. */
  const stacking = (el: Element): number => {
    let z = 0;
    for (let at: Element | null = el; at; at = at.parentElement) {
      const value = Number(doc.defaultView?.getComputedStyle(at).zIndex);
      if (Number.isFinite(value)) z = Math.max(z, value);
    }
    return z;
  };
  let top: Element | undefined;
  for (const modal of widgets.filter((el) => roleOf(el).endsWith('dialog') && el.getAttribute('aria-modal') === 'true')) {
    if (!top || stacking(modal) >= stacking(top)) top = modal;
  }
  if (top && !top.contains(doc.activeElement)) problems.push(`${said(top, 'dialog')}: an open modal dialog does not hold the focus`);
  const resting = doc.activeElement;
  if (resting && resting.closest('[inert]')) problems.push('the focus is inside inert content');

  if (opts.keys === false) return problems;

  /* ---- The keys, pattern by pattern ---- */

  /* `holder` is the element carrying aria-activedescendant, or null where the focus itself roves. */
  const moves = async (who: string, holder: Element | null, container: Element, role: string, keys: [string, string]) => {
    const all = items(container, role);
    const list = all.filter((item) => !disabled(item));
    if (list.length < 2) return;
    const on = () => holder ?? (container.contains(doc.activeElement) ? doc.activeElement! : container);
    const now = () => current(holder ?? container, container);
    const before = now();
    await press(on(), keys[1]);
    if (now() === before) problems.push(`${who}: ${keys[1]} does not move to another item`);
    focusHolds(who, keys[1]);
    await press(on(), 'Home');
    if (now() !== list[0] && now() !== all[0]) problems.push(`${who}: Home does not move to the first item`);
    await press(on(), 'End');
    if (now() !== list.at(-1) && now() !== all.at(-1)) problems.push(`${who}: End does not move to the last item`);
    await press(on(), keys[0]);
    focusHolds(who, keys[0]);
  };
  const closes = async (who: string, holder: Element, popup: Element, box?: Element) => {
    await press(holder, 'Escape');
    const gone = !popup.isConnected || hidden(popup) || (box !== undefined && box.getAttribute('aria-expanded') !== 'true');
    if (!gone) problems.push(`${who}: Escape does not close it`);
    focusHolds(who, 'Escape');
  };

  for (const el of widgets) {
    if (!el.isConnected || hidden(el) || native(el)) continue;
    const role = roleOf(el);
    const who = said(el, role);

    if (role === 'tablist') {
      const tabs = items(el, 'tablist');
      const home = tabs.find(tabbable);
      const live = tabs.filter((tab) => !disabled(tab));
      if (!home || live.length < 2) continue;
      // Counted among the tabs an arrow can land on: it skips a disabled one, so counting it would overshoot.
      const back = live.indexOf(home);
      const vertical = el.getAttribute('aria-orientation') === 'vertical';
      await focus(home);
      await press(home, 'End');
      if (doc.activeElement !== tabs.filter((tab) => !disabled(tab)).at(-1)) problems.push(`${who}: End does not move to the last tab`);
      await press(doc.activeElement ?? home, 'Home');
      if (doc.activeElement !== tabs.find((tab) => !disabled(tab))) problems.push(`${who}: Home does not move to the first tab`);
      const first = doc.activeElement;
      await press(first ?? home, vertical ? 'ArrowDown' : 'ArrowRight');
      if (doc.activeElement === first) problems.push(`${who}: ${vertical ? 'ArrowDown' : 'ArrowRight'} does not move to the next tab`);
      focusHolds(who, 'the arrow keys');
      // Walk back to the tab that was chosen, so reading the page leaves it as it was.
      await press(doc.activeElement ?? home, 'Home');
      for (let i = 0; i < back; i++) await press(doc.activeElement ?? home, vertical ? 'ArrowDown' : 'ArrowRight');
      continue;
    }

    if (role === 'combobox' && el.getAttribute('aria-expanded') === 'true') {
      const popup = [...driven].find(([, box]) => box === el)?.[0];
      if (!popup || hidden(popup)) continue;
      const kind = roleOf(popup);
      await focus(el);
      const list = kind === 'listbox' || kind === 'tree' ? items(popup, kind).filter((item) => !disabled(item)) : [];
      if (list.length >= 2) {
        const before = current(el, popup);
        await press(el, 'ArrowDown');
        if (current(el, popup) === before) problems.push(`${who}: ArrowDown does not move to another item in its ${kind}`);
        await press(el, 'ArrowUp');
      }
      await closes(who, el, popup, el);
      continue;
    }

    if (role === 'menu') {
      const holder = el.contains(doc.activeElement) ? doc.activeElement! : null;
      if (!holder) {
        problems.push(`${who}: an open menu does not hold the focus`);
        continue;
      }
      await moves(who, holder.hasAttribute('aria-activedescendant') ? holder : null, el, 'menu', ['ArrowUp', 'ArrowDown']);
      await closes(who, doc.activeElement && el.contains(doc.activeElement) ? doc.activeElement : el, el);
      continue;
    }

    if ((role === 'listbox' || role === 'tree') && !driven.has(el)) {
      let holder: Element | null = el.contains(doc.activeElement) ? doc.activeElement : null;
      if (!holder) {
        const stop = [el, ...el.querySelectorAll('*')].find(tabbable);
        if (!stop) continue;
        await focus(stop);
        holder = stop;
      }
      await moves(who, holder.hasAttribute('aria-activedescendant') ? holder : null, el, role, ['ArrowUp', 'ArrowDown']);
      if (isPopup(el)) await closes(who, doc.activeElement && el.contains(doc.activeElement) ? doc.activeElement : el, el);
      continue;
    }

    if (role === 'radiogroup') {
      const radios = items(el, 'radiogroup');
      // Native radios move by the browser's own keys, which a dispatched key does not reach.
      if (radios.some((radio) => radio.tagName === 'INPUT')) continue;
      const home = radios.find(tabbable);
      if (!home || radios.filter((radio) => !disabled(radio)).length < 2) continue;
      await focus(home);
      await press(home, 'ArrowDown');
      if (doc.activeElement === home) problems.push(`${who}: ArrowDown does not move to the next radio`);
      focusHolds(who, 'ArrowDown');
      await press(doc.activeElement ?? home, 'ArrowUp');
    }
  }

  return problems;
}
