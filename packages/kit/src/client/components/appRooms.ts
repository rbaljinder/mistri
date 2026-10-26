/**
 * The served App's rooms and menu, as the client draws them: its views in
 * the menu's order, each under its view key — a list with what its resource
 * lets it offer, a dashboard with its sections, a signed-in form with its
 * command — and nav's references
 * resolved to those rooms. Pure over the payload, and computed once per
 * served App, so every reader compares the same objects.
 */
import {
  ASSISTANT_ROOM,
  isServedForm as isFormView,
  viewOrder,
  type ServedApp as ServedAppShape,
  type ServedDashboardView,
  type ServedFormView,
  type ServedResource,
} from '@mistriwork/engine/shared/servedApp.js';
import { embeddedOnlyViews } from '@mistriwork/engine/shared/appEmbeds.js';
import { navigationTree, type NavigationNode, type AvailableNavigationNode } from './navigationTree.js';
import type { ListSpec } from './appListModel.js';
import type { BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { say } from '../copy/public/components/appRooms.js';

/** A list view as served: what its room offers, with its actions named by the ids its resource's actions go by. */
type ServedListView = Omit<ListSpec, 'id' | 'form' | 'actions' | 'noun'> & { actions?: string[] };

/** The App on screen as the kit reads it (shellMode.ts `app()`): the served App (servedApp.ts), its views lists,
    dashboards and signed-in forms. The App framework's payload (appPayload.ts) is one. */
export type ShownApp = ServedAppShape<ServedListView | ServedDashboardView | ServedFormView>;

type ServedApp = Pick<ShownApp, 'views' | 'nav' | 'resources' | 'home'> & Partial<Pick<ShownApp, 'assistant'>>;

/* The rooms are the served views themselves, under their keys, so a room is typed by the App that serves it:
   the kit's own reading of a dashboard or a form (ShownApp), or the App framework's whole payload, whose rooms
   carry everything it serves. */
type ViewOf<A extends ServedApp> = A['views'][string];

/** A dashboard as a room: the served dashboard under its view key. */
type DashboardOf<A extends ServedApp> = Extract<ViewOf<A>, { sections: unknown }> & { id: string };

/** A signed-in form as a room: the served form under its view key. */
export type ServedForm<A extends ServedApp = ShownApp> = Extract<ViewOf<A>, { command: unknown }> & { id: string };

/** The assistant's own room (`placement: 'page'`), where the App gives it one: no view behind it, its word in nav. */
export interface AssistantRoom {
  id: typeof ASSISTANT_ROOM;
  assistant: true;
  label: string;
  icon: 'chat-circle';
  error?: undefined;
}

/** A room the App opens, under its view key: one of its list views, a dashboard, a signed-in form, or the assistant's page. */
type RoomOf<A extends ServedApp> = (ListSpec & { id: string }) | DashboardOf<A> | ServedForm<A> | AssistantRoom;
type AppRoom = RoomOf<ShownApp>;

/** What a menu draws for one of nav's references: its room, under the menu's word for it. */
/** A room as its menu entry draws it: with the series color (1–8) of the dot nav gives it in its icon's place. */
export type MenuEntry<A extends ServedApp = ShownApp> = RoomOf<A> & { navColor?: number };

/** The page id a dashboard rides, `dash-<view key>`: what its address carries. */
export const dashPageId = (view: string): string => `dash-${view}`;

/** The view key behind a dashboard's page id; undefined for any other page. */
export const dashViewKey = (pageId: string | undefined): string | undefined =>
  pageId?.startsWith('dash-') ? pageId.slice('dash-'.length) : undefined;

/** The page id a signed-in form rides, `form-<view key>`. */
export const formPageId = (view: string): string => `form-${view}`;

/** The view key behind a form's page id; undefined for any other page. */
export const formViewKey = (pageId: string | undefined): string | undefined =>
  pageId?.startsWith('form-') ? pageId.slice('form-'.length) : undefined;

/** The page id the signed-in person's notifications ride: a reserved id no authored page can take (a page id is a key). */
export const INBOX_PAGE = 'app:inbox';

/** The page id the assistant's own room rides, reserved as the inbox's is. */
export const ASSISTANT_PAGE = 'app:assistant';

/** Whether a room is the assistant's page. */
export const isAssistantRoom = (room: object): room is AssistantRoom => Object.hasOwn(room, 'assistant');

/** Whether a room is one of the App's lists: neither a dashboard, a form nor the assistant's page. */
export const isListRoom = (room: AppRoom): room is ListSpec & { id: string } =>
  !('sections' in room) && !isFormView(room) && !isAssistantRoom(room);

/** The page a screen of the App's own rides — a dashboard's `dash-<key>`, a form's `form-<key>`, the assistant's — or undefined for a list, which rides the table. */
export const roomPageId = (room: AppRoom): string | undefined =>
  'sections' in room ? dashPageId(room.id) : isFormView(room) ? formPageId(room.id) : isAssistantRoom(room) ? ASSISTANT_PAGE : undefined;

/** A resource's word for its rows, by table id: never a name borrowed from Object.prototype. */
export function resourceOf(app: Pick<ShownApp, 'resources'> | null | undefined, tableId: string): ServedResource | undefined {
  return app && Object.hasOwn(app.resources, tableId) ? app.resources[tableId] : undefined;
}

/** What a list over a resource offers: its New form, its actions narrowed by the selector a queue or a board names, and what one of its records is called. */
export function offeredBy(resource: ServedResource | undefined, selector?: string[]): Pick<ListSpec, 'form' | 'actions' | 'noun'> {
  const declared = resource?.actions;
  const actions = declared && (selector === undefined ? declared : selector.flatMap((id) => declared.filter((action) => action.id === id)));
  return {
    ...(actions ? { actions } : {}),
    ...(resource?.form ? { form: resource.form } : {}),
    ...(resource?.noun ? { noun: resource.noun } : {}),
  };
}

const everyRoom = new WeakMap<object, Map<string, AppRoom>>();

/** Every room the App serves, by view key, in the menu's order. */
function roomsByKey<A extends ServedApp>(served: A): Map<string, RoomOf<A>> {
  const app: ServedApp = served;
  let held = everyRoom.get(app);
  if (!held) {
    held = new Map(
      viewOrder(app).map((key): [string, AppRoom] => {
        const view = app.views[key];
        if ('sections' in view) return [key, { id: key, ...view }];
        if (isFormView(view)) return [key, { id: key, ...view }];
        const { actions: selector, ...list } = view;
        return [key, { id: key, ...list, ...offeredBy(resourceOf(app, view.table), selector) }];
      }),
    );
    /* Only where this person is offered it: nav's word for it resolves to nothing otherwise, and the menu drops it. */
    if (app.assistant?.page)
      held.set(ASSISTANT_ROOM, { id: ASSISTANT_ROOM, assistant: true, label: say('assistant'), icon: 'chat-circle' });
    everyRoom.set(app, held);
  }
  return held as Map<string, RoomOf<A>>;
}

/**
 * The room behind a view key, listed or not. The walk's `view` finds a
 * list room this way — a room only a dashboard embeds is found no other
 * way — and a dashboard's address finds its dashboard.
 */
export function viewRoom<A extends ServedApp>(app: A, key: string): RoomOf<A> | undefined {
  return roomsByKey(app).get(key);
}

/** The dashboard a `dash-<view key>` page id names, or undefined. */
export function dashboardAt<A extends ServedApp>(app: A, pageId: string | undefined): DashboardOf<A> | undefined {
  const key = dashViewKey(pageId);
  const room: AppRoom | undefined = key === undefined ? undefined : viewRoom(app, key);
  return room && 'sections' in room ? (room as DashboardOf<A>) : undefined;
}

/** The signed-in form a `form-<view key>` page id names, or undefined. */
export function formAt<A extends ServedApp>(app: A, pageId: string | undefined): ServedForm<A> | undefined {
  const key = formViewKey(pageId);
  const room: AppRoom | undefined = key === undefined ? undefined : viewRoom(app, key);
  return room && isFormView(room) ? (room as ServedForm<A>) : undefined;
}

const listedRooms = new WeakMap<object, AppRoom[]>();

/**
 * Every room the App lists, in the menu's order, then the views nav does not
 * reference — the home of an App without nav among them. A list view only a
 * dashboard embeds has a room too (viewRoom), where the embed's "open →"
 * goes, but nothing lists it: no menu, no palette, and no list found by its
 * table — unless it is the home this visitor was served.
 */
export function appRooms<A extends ServedApp>(served: A): RoomOf<A>[] {
  const app: ServedApp = served;
  let held = listedRooms.get(app);
  if (!held) {
    const embeddedOnly = embeddedOnlyViews(app, app.home === undefined ? [] : [app.home]);
    held = [...roomsByKey(app).values()].filter((room) => !embeddedOnly.has(room.id));
    listedRooms.set(app, held);
  }
  return held as RoomOf<A>[];
}

/** Whether the App has a room at all: an App whose every view a principal cannot draw is no App to that principal. */
export const hasRooms = (app: Pick<ShownApp, 'views'> | null | undefined): boolean => Boolean(app && Object.keys(app.views).length);

const menus = new WeakMap<object, NavigationNode<MenuEntry>[]>();

/** The App's nav as a menu draws it, each reference resolved to its room, and each target to where it leads now (`hrefOf`). */
export function appMenu<A extends ServedApp>(app: A): NavigationNode<MenuEntry<A>>[];
export function appMenu<A extends ServedApp>(
  app: A,
  hrefOf: (target: BoundAppTarget) => string | undefined,
): AvailableNavigationNode<MenuEntry<A>>[];
export function appMenu(app: ServedApp, hrefOf?: (target: BoundAppTarget) => string | undefined): AvailableNavigationNode<MenuEntry>[] {
  if (hrefOf)
    return navigationTree(
      app.nav,
      (view, label, color) => {
        const room = roomsByKey(app).get(view);
        return !room || (room.label === label && !color) ? room : { ...room, label, ...(color ? { navColor: color } : {}) };
      },
      hrefOf,
    );
  let held = menus.get(app);
  if (!held) {
    const byKey = roomsByKey(app);
    held = navigationTree(app.nav, (view, label, color) => {
      const room = byKey.get(view);
      return !room || (room.label === label && !color) ? room : { ...room, label, ...(color ? { navColor: color } : {}) };
    });
    menus.set(app, held);
  }
  return held;
}

/**
 * The room the served home names: the list or dashboard this visitor starts
 * on. The server resolved it (`home` in the payload); this only looks it up.
 * Undefined for a public home — the landing or a public form, which are no
 * rooms — and for an App that served none.
 */
export function homeRoom<A extends ServedApp>(app: A): RoomOf<A> | undefined {
  return app.home === undefined ? undefined : viewRoom(app, app.home);
}
