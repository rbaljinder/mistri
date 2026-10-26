/**
 * The landing view: the App's signed-out front page, keyed in `views` and
 * public by kind, so `realm` is refused on it. It is read into the AppDef's
 * `landing`, which the public route serves; its calls to action open the
 * App's public forms (appForms.ts).
 */
import {
  LANDING_ACTION_INTENTS,
  LANDING_HERO_LAYOUTS,
  LANDING_LIMITS,
  LANDING_SECTION_KINDS,
  type AppLanding,
  type AppListView,
  type LandingAction,
  type LandingActionIntent,
  type LandingBadge,
  type LandingPoint,
  type LandingFooter,
  type LandingHero,
  type LandingHeroLayout,
  type LandingImage,
  type LandingItem,
  type LandingLink,
  type LandingSearch,
  type LandingSection,
} from './appModel.js';
import { allowKeys } from '@mistriwork/engine/shared/model.js';
import { parseIcon } from '@mistriwork/engine/shared/appIcons.js';

/**
 * What a landing may open and show, as the views parser found them: the
 * App's public forms and — where `auth.public` lets signed-out visitors read
 * — the list and dashboard views whose every table the public reads, with
 * the list views themselves for a section that draws or searches one.
 */
interface LandingRooms {
  forms: ReadonlySet<string>;
  views: ReadonlySet<string>;
  lists: ReadonlyMap<string, AppListView>;
  /** The resources whose rows are files that `auth.public` reads: where a hero's photo may come from. */
  images: ReadonlySet<string>;
}

/* ---------- the landing ----------
   Each string is trimmed, held to its ceiling, and kept as plain text: the
   page draws it as text, so markup in it is shown, never run. The only
   strings that become attributes are hrefs, and they are held to three
   schemes a public page can safely link to. */

function landingObject(raw: unknown, at: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at} is not an object.`);
  return raw as Record<string, unknown>;
}

function landingText(o: Record<string, unknown>, key: string, max: number, at: string, required = false): string | undefined {
  const value = o[key];
  if (value === undefined) {
    if (required) throw new Error(`${at} needs a "${key}": plain text of at most ${max} characters.`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${at} has a "${key}" that is not text.`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${at} has a "${key}" of ${text.length} characters; the most is ${max}.`);
  return text;
}

function landingList(o: Record<string, unknown>, key: string, max: number, at: string): unknown[] {
  const value = o[key];
  if (!Array.isArray(value) || !value.length) throw new Error(`${at} needs "${key}": a list of 1 to ${max}.`);
  if (value.length > max) throw new Error(`${at} has ${value.length} "${key}"; the most is ${max}.`);
  return value;
}

/* https with a host and no credentials; mailto with an address; tel with
   digits. A relative path, http:, javascript:, data: and everything else
   are refused — a public page's links are the author's, checked once here. */
const LANDING_HREFS = [
  /^https:\/\/[^\s/?#@\\]+(?:[/?#][^\s]*)?$/i,
  /^mailto:[^\s@<>"?/]+@[^\s@<>"?/]+(?:\?[^\s<>"]*)?$/i,
  /^tel:\+?[0-9][0-9().-]{2,31}$/i,
];

/** Why an href may not be a landing link, or undefined when it may. */
export function landingHrefProblem(href: string): string | undefined {
  if (href.length > LANDING_LIMITS.href) return `is longer than ${LANDING_LIMITS.href} characters`;
  if (!LANDING_HREFS.some((pattern) => pattern.test(href))) return 'is not an https://, mailto: or tel: address';
  if (/^https:/i.test(href)) {
    try {
      if (!new URL(href).hostname) return 'has no host';
    } catch {
      return 'is not a URL';
    }
  }
  return undefined;
}

function parseLandingLink(raw: unknown, at: string): LandingLink {
  const o = landingObject(raw, at);
  allowKeys(o, ['label', 'href'], at);
  const label = landingText(o, 'label', 80, at, true)!;
  if (typeof o.href !== 'string' || !o.href.trim()) throw new Error(`${at} needs an "href": an https://, mailto: or tel: address.`);
  const href = o.href.trim();
  const problem = landingHrefProblem(href);
  if (problem) {
    const shown = href.length > 60 ? `${href.slice(0, 57)}...` : href;
    throw new Error(
      `${at} has an "href" of "${shown}", which ${problem}. A landing links only to https://, mailto: or tel: — never a relative path, http:, javascript: or data:.`,
    );
  }
  return { label, href };
}

function parseLandingActions(o: Record<string, unknown>, at: string, rooms: LandingRooms): LandingAction[] {
  return landingList(o, 'actions', LANDING_LIMITS.actions, at).map((raw, index) => {
    const here = `${at}, action ${index + 1}`;
    const a = landingObject(raw, here);
    allowKeys(a, ['label', 'to', 'signIn', 'intent'], here, { kind: 'is now "intent", as a button says it: "primary" or "secondary"' });
    const label = landingText(a, 'label', LANDING_LIMITS.label, here, true)!;
    if (a.intent !== undefined && !(LANDING_ACTION_INTENTS as readonly unknown[]).includes(a.intent)) {
      throw new Error(`${here} has an "intent" of "${String(a.intent)}". Use "primary" or "secondary".`);
    }
    const kind = a.intent === undefined ? {} : { intent: a.intent as LandingActionIntent };
    if ((a.to === undefined) === (a.signIn === undefined)) {
      throw new Error(`${here} needs exactly one of "to" (a public form view this App declares) or "signIn: true".`);
    }
    if (a.signIn !== undefined) {
      if (a.signIn !== true) throw new Error(`${here} has a "signIn" that is not true.`);
      return { label, signIn: true as const, ...kind };
    }
    /* A public form, or — in an App that opens resources to the public — a
       list or dashboard whose every table a signed-out visitor reads. A
       call to action that would meet a sign-in screen is a typo. */
    if (typeof a.to !== 'string' || (!rooms.forms.has(a.to) && !rooms.views.has(a.to))) {
      const declared = [...rooms.forms];
      const open = [...rooms.views];
      throw new Error(
        `${here} names the view "${String(a.to)}", which is not a public form view this App declares` +
          (open.length ? ' or a view a signed-out visitor may open' : '') +
          '. ' +
          (declared.length ? `Its public form views: ${declared.join(', ')}.` : 'It declares no public form view.') +
          (open.length ? ` Views open to signed-out visitors: ${open.join(', ')}.` : ''),
      );
    }
    return { label, view: a.to, ...kind };
  });
}

/* The line under a heading is `description` everywhere (renamed before 1.0); a text section's prose and a footer's small
   print stay `text`. */
const LANDING_TEXT_RENAMED = { text: 'is now "description": the line under the title' } as const;

function parseLandingItems(o: Record<string, unknown>, at: string): LandingItem[] {
  return landingList(o, 'items', LANDING_LIMITS.items, at).map((raw, index) => {
    const here = `${at}, item ${index + 1}`;
    const item = landingObject(raw, here);
    allowKeys(item, ['title', 'description'], here, LANDING_TEXT_RENAMED);
    return {
      title: landingText(item, 'title', LANDING_LIMITS.title, here, true)!,
      description: landingText(item, 'description', LANDING_LIMITS.text, here, true)!,
    };
  });
}

/* A section that reads data names a list view a signed-out visitor may read:
   the landing is a signed-out page, and nothing on it needs a session. */
function openList(o: Record<string, unknown>, at: string, rooms: LandingRooms): [string, AppListView] {
  const key = o.view;
  const view = typeof key === 'string' ? rooms.lists.get(key) : undefined;
  if (!view) {
    const open = [...rooms.lists.keys()];
    throw new Error(
      `${at} names the view "${String(key)}", which is not a list view a signed-out visitor may read. A landing shows rows only ` +
        'from a list view over a resource "auth.public" names. ' +
        (open.length ? `Such list views: ${open.join(', ')}.` : 'This App has none.'),
    );
  }
  return [key as string, view];
}

/** A search, as a section or inside the hero: the list's own filters, each once. */
function parseSearch(o: Record<string, unknown>, here: string, rooms: LandingRooms): LandingSearch {
  const [view, list] = openList(o, here, rooms);
  const offered = list.filters ?? [];
  const filters = landingList(o, 'filters', LANDING_LIMITS.filters, here).map((filter, index) => {
    if (typeof filter !== 'string' || !offered.includes(filter.trim())) {
      throw new Error(
        `${here}, filter ${index + 1} is "${String(filter)}", which is not one of the view "${view}"'s filters. A search offers the list's own filters` +
          (offered.length ? `: ${offered.join(', ')}.` : ', and it has none.'),
      );
    }
    return filter.trim();
  });
  if (new Set(filters).size !== filters.length) throw new Error(`${here} names one filter twice.`);
  const submitLabel = landingText(o, 'submitLabel', LANDING_LIMITS.label, here);
  return { view, filters, ...(submitLabel === undefined ? {} : { submitLabel }) };
}

/* A hero's photo is one row of a file resource, named by its key, and only
   one a signed-out visitor may read: the landing is their page. */
function parseImage(raw: unknown, at: string, rooms: LandingRooms): LandingImage {
  const o = landingObject(raw, at);
  allowKeys(o, ['from', 'key', 'alt'], at);
  if (typeof o.from !== 'string' || !rooms.images.has(o.from.trim())) {
    const open = [...rooms.images];
    throw new Error(
      `${at} takes its photo from "${String(o.from)}", which is not a resource of files a signed-out visitor may read. ` +
        'Declare "file" on the resource and name it in "auth.public.read". ' +
        (open.length ? `Such resources: ${open.join(', ')}.` : 'This App has none.'),
    );
  }
  const key = o.key;
  if (!((typeof key === 'string' && key.trim()) || (typeof key === 'number' && Number.isFinite(key)))) {
    throw new Error(`${at} needs a "key": the record key of the row that holds the photo, like 1.`);
  }
  const alt = landingText(o, 'alt', LANDING_LIMITS.alt, at, true)!;
  return { from: o.from.trim(), key: typeof key === 'string' ? key.trim() : key, alt };
}

/* Photo tiles: two to four photos beside the hero's words, each a row a visitor may read, as the one wide photo is. */
function parseTiles(h: Record<string, unknown>, at: string, rooms: LandingRooms): LandingImage[] {
  const raw = h.tiles;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > LANDING_LIMITS.tiles)
    throw new Error(`${at} has "tiles" that are not a list of 2 to ${LANDING_LIMITS.tiles} photos; one photo is "image".`);
  return raw.map((tile, index) => parseImage(tile, `${at}, tile ${index + 1}`, rooms));
}

/* A badge: a few words in a pill over the heading, and an App icon where it names one. */
function parseBadge(raw: unknown, at: string): LandingBadge {
  const o = landingObject(raw, at);
  allowKeys(o, ['text', 'icon'], at);
  const text = landingText(o, 'text', LANDING_LIMITS.badge, at, true)!;
  return { text, ...(o.icon === undefined ? {} : { icon: parseIcon(o.icon, at) }) };
}

/* Icon rows: up to four, each an App icon and a short line. */
function parsePoints(h: Record<string, unknown>, at: string): LandingPoint[] {
  return landingList(h, 'points', LANDING_LIMITS.points, at).map((raw, index) => {
    const here = `${at}, point ${index + 1}`;
    const o = landingObject(raw, here);
    allowKeys(o, ['icon', 'text'], here);
    if (o.icon === undefined) throw new Error(`${here} needs an "icon": an App icon, like 'shield-check'.`);
    return { icon: parseIcon(o.icon, here), text: landingText(o, 'text', LANDING_LIMITS.highlight, here, true)! };
  });
}

/** One sort key, as the query bar writes it: "listed_on desc". */
const SORT = /^[A-Za-z_][A-Za-z0-9_]*(?: (?:asc|desc))?$/i;

function parseLandingSection(raw: unknown, at: string, rooms: LandingRooms): LandingSection {
  const o = landingObject(raw, at);
  const kind = o.kind;
  if (kind === 'cta') throw new Error(`${at} has a "kind" of "cta", which is now "callToAction", as its helper callToAction() says it.`);
  if (!(LANDING_SECTION_KINDS as readonly unknown[]).includes(kind)) {
    throw new Error(`${at} has a "kind" of "${String(kind)}". It is one of: ${LANDING_SECTION_KINDS.join(', ')}.`);
  }
  const here = `${at} ("${String(kind)}")`;
  const titled = (required = false) => {
    const title = landingText(o, 'title', LANDING_LIMITS.title, here, required);
    return title === undefined ? {} : { title };
  };
  switch (kind as LandingSection['kind']) {
    case 'features':
    case 'steps':
      allowKeys(o, ['kind', 'title', 'items'], here);
      return { kind: kind as 'features' | 'steps', ...titled(), items: parseLandingItems(o, here) };
    case 'faq':
      allowKeys(o, ['kind', 'title', 'items'], here);
      return {
        kind: 'faq',
        ...titled(),
        items: landingList(o, 'items', LANDING_LIMITS.questions, here).map((entry, index) => {
          const q = `${here}, question ${index + 1}`;
          const item = landingObject(entry, q);
          allowKeys(item, ['question', 'answer'], q);
          return {
            question: landingText(item, 'question', LANDING_LIMITS.question, q, true)!,
            answer: landingText(item, 'answer', LANDING_LIMITS.answer, q, true)!,
          };
        }),
      };
    case 'text':
      allowKeys(o, ['kind', 'title', 'text'], here);
      return { kind: 'text', ...titled(), text: landingText(o, 'text', LANDING_LIMITS.prose, here, true)! };
    case 'callToAction': {
      allowKeys(o, ['kind', 'title', 'description', 'actions'], here, LANDING_TEXT_RENAMED);
      const description = landingText(o, 'description', LANDING_LIMITS.text, here);
      return {
        kind: 'callToAction',
        title: landingText(o, 'title', LANDING_LIMITS.title, here, true)!,
        ...(description === undefined ? {} : { description }),
        actions: parseLandingActions(o, here, rooms),
      };
    }
    case 'view': {
      allowKeys(o, ['kind', 'title', 'view', 'limit', 'sort'], here);
      const [view, list] = openList(o, here, rooms);
      if (list.presentation?.kind !== 'cards') {
        throw new Error(
          `${here} shows "${view}", which is not drawn as cards. A landing is a page, not a tool: give the view a cards presentation.`,
        );
      }
      if (
        o.limit !== undefined &&
        (typeof o.limit !== 'number' || !Number.isInteger(o.limit) || o.limit < 1 || o.limit > LANDING_LIMITS.shown)
      ) {
        throw new Error(`${here} has a "limit" that is not a whole number from 1 to ${LANDING_LIMITS.shown}.`);
      }
      if (o.sort !== undefined && (typeof o.sort !== 'string' || !SORT.test(o.sort.trim()))) {
        throw new Error(`${here} has a "sort" that is not one column and a direction, like "listed_on desc".`);
      }
      return {
        kind: 'view',
        ...titled(),
        view,
        ...(o.limit === undefined ? {} : { limit: o.limit as number }),
        ...(o.sort === undefined ? {} : { sort: (o.sort as string).trim() }),
      };
    }
    case 'search':
      allowKeys(o, ['kind', 'title', 'view', 'filters', 'submitLabel'], here);
      return { kind: 'search', ...titled(), ...parseSearch(o, here, rooms) };
    case 'contact':
      allowKeys(o, ['kind', 'title', 'items'], here);
      return {
        kind: 'contact',
        ...titled(),
        items: landingList(o, 'items', LANDING_LIMITS.links, here).map((entry, index) =>
          parseLandingLink(entry, `${here}, item ${index + 1}`),
        ),
      };
  }
}

/** Every view a landing opens or shows: what reaches them, for the views parser's reachability check. */
/**
 * A footer: a line of small print and a row of links, `ui.footer`, drawn under
 * every room. The landing wears it too (the server serves it with the landing),
 * so an App says its small print once.
 */
export function parseFooter(raw: unknown, at: string): LandingFooter {
  const f = landingObject(raw, at);
  allowKeys(f, ['text', 'links'], at);
  const text = landingText(f, 'text', LANDING_LIMITS.text, at);
  const links =
    f.links === undefined
      ? undefined
      : landingList(f, 'links', LANDING_LIMITS.links, at).map((entry, index) => parseLandingLink(entry, `${at}, link ${index + 1}`));
  return { ...(text === undefined ? {} : { text }), ...(links === undefined ? {} : { links }) };
}

export function landingViews(landing: AppLanding): string[] {
  const actions = [
    ...landing.hero.actions,
    ...(landing.sections ?? []).flatMap((section) => (section.kind === 'callToAction' ? section.actions : [])),
  ];
  return [
    ...actions.flatMap((action) => ('view' in action ? [action.view] : [])),
    ...(landing.hero.search ? [landing.hero.search.view] : []),
    ...(landing.sections ?? []).flatMap((section) => (section.kind === 'view' || section.kind === 'search' ? [section.view] : [])),
  ];
}

/**
 * The landing view. A call to action must name a public form view this App
 * declares or a view a signed-out visitor may open — a call to action that
 * leads nowhere is a typo — and a section that reads data a list view the
 * public reads, so what the views parser found is passed in.
 */
export function parseLandingView(raw: unknown, at: string, rooms: LandingRooms): AppLanding {
  const o = landingObject(raw, at);
  allowKeys(o, ['kind', 'label', 'hero', 'sections'], at, { realm: 'is not taken: a landing is public by kind' });
  // The browser title: as long as a section's title may be.
  const label = landingText(o, 'label', LANDING_LIMITS.title, at);
  if (o.hero === undefined) throw new Error(`${at} needs a "hero": { heading, description?, actions }.`);
  const heroAt = `${at}, hero`;
  const h = landingObject(o.hero, heroAt);
  allowKeys(
    h,
    ['heading', 'description', 'actions', 'image', 'layout', 'search', 'highlights', 'badge', 'tiles', 'points'],
    heroAt,
    LANDING_TEXT_RENAMED,
  );
  const heroText = landingText(h, 'description', LANDING_LIMITS.text, heroAt);
  const image = h.image === undefined ? undefined : parseImage(h.image, `${heroAt}, image`, rooms);
  const tiles = h.tiles === undefined ? undefined : parseTiles(h, heroAt, rooms);
  if (image && tiles) throw new Error(`${heroAt} has an "image" and "tiles": one wide photo, or two to four tiles, not both.`);
  if (h.layout !== undefined) {
    if (tiles) throw new Error(`${heroAt} has "tiles" and a "layout": tiles sit beside the words, as "split" does.`);
    if (!image) throw new Error(`${heroAt} has a "layout" and no "image": the layout places the hero's photo.`);
    if (!(LANDING_HERO_LAYOUTS as readonly unknown[]).includes(h.layout))
      throw new Error(`${heroAt} has a "layout" of "${String(h.layout)}". Use "split" or "overlay".`);
  }
  let search: LandingSearch | undefined;
  if (h.search !== undefined) {
    const searchAt = `${heroAt}, search`;
    const s = landingObject(h.search, searchAt);
    allowKeys(s, ['view', 'filters', 'submitLabel'], searchAt);
    search = parseSearch(s, searchAt, rooms);
  }
  const highlights =
    h.highlights === undefined
      ? undefined
      : landingList(h, 'highlights', LANDING_LIMITS.highlights, heroAt).map((_, index) =>
          landingText(
            h.highlights as unknown as Record<string, unknown>,
            String(index),
            LANDING_LIMITS.highlight,
            `${heroAt}, highlight ${index + 1}`,
            true,
          )!,
        );
  const points = h.points === undefined ? undefined : parsePoints(h, heroAt);
  if (points && highlights)
    throw new Error(`${heroAt} has "highlights" and "points": one quiet line of words, or rows with icons, not both.`);
  const badge = h.badge === undefined ? undefined : parseBadge(h.badge, `${heroAt}, badge`);
  const hero: LandingHero = {
    heading: landingText(h, 'heading', LANDING_LIMITS.heading, heroAt, true)!,
    ...(heroText === undefined ? {} : { description: heroText }),
    actions: parseLandingActions(h, heroAt, rooms),
    ...(image ? { image, layout: (h.layout ?? 'split') as LandingHeroLayout } : {}),
    ...(tiles ? { tiles } : {}),
    ...(search ? { search } : {}),
    ...(highlights ? { highlights } : {}),
    ...(badge ? { badge } : {}),
    ...(points ? { points } : {}),
  };
  let sections: LandingSection[] | undefined;
  if (o.sections !== undefined) {
    if (!Array.isArray(o.sections)) throw new Error(`${at} has "sections" that is not a list.`);
    if (o.sections.length > LANDING_LIMITS.sections)
      throw new Error(`${at} has ${o.sections.length} sections; the most is ${LANDING_LIMITS.sections}.`);
    sections = o.sections.map((entry, index) => parseLandingSection(entry, `${at}, section ${index + 1}`, rooms));
  }
  return {
    ...(label === undefined ? {} : { label }),
    hero,
    ...(sections === undefined ? {} : { sections }),
  };
}
