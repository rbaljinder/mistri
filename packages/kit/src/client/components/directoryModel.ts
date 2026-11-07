/**
 * The Directory's lines (Directory.tsx): every place a long menu leads — its lists, its pages, its links — grouped as
 * the menu groups them, then the rooms nav does not name, then every New this reader may use. Filtered by the
 * palette's own matcher (paletteModel.ts `score`), so a word finds here what it finds there.
 */
import { go, pageView, state, tableView } from '../core.js';
import { shell } from '../shellMode.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { appListQuery } from './appListModel.js';
import { appMenu, appRooms, isListRoom, roomPageId, type MenuEntry, type ShownApp } from './appRooms.js';
import type { AvailableNavigationNode } from './navigationTree.js';
import { newPaletteItems } from './newMenuModel.js';
import { score } from './paletteModel.js';
import { say } from '../copy/shell/components/directoryModel.js';

export interface DirectoryLine {
  key: string;
  label: string;
  /** What it is, said under its name: a list, a page, a link, a New. */
  kind: 'list' | 'page' | 'link' | 'new';
  icon?: string;
  /** Where a link leads, drawn as one so it opens in a new tab like any link. */
  href?: string;
  open: () => void;
}
interface DirectorySection {
  /** The menu's group, as it heads its rows there; none for the menu's top level. */
  label?: string;
  lines: DirectoryLine[];
}

const visit = (entry: MenuEntry) => {
  if (isListRoom(entry)) go({ ...tableView(entry.table, appListQuery(entry)), view: entry.id }, 'reset');
  else go(pageView(roomPageId(entry)!, undefined, undefined, entry.label), 'reset');
};

function lineOf(entry: MenuEntry): DirectoryLine {
  return {
    key: `room:${entry.id}`,
    label: entry.label,
    kind: isListRoom(entry) ? 'list' : 'page',
    ...(entry.icon ? { icon: entry.icon } : {}),
    open: () => visit(entry),
  };
}

/** The lines a menu node holds, its nested groups' included: a group inside a group is one section, read in order. */
function linesOf(node: AvailableNavigationNode<MenuEntry>): DirectoryLine[] {
  if (node.kind === 'destination') return node.entry.error ? [] : [lineOf(node.entry)];
  if (node.kind === 'target')
    return [{ key: `link:${node.href}`, label: node.label, kind: 'link', href: node.href, open: () => window.location.assign(node.href) }];
  return node.children.flatMap(linesOf);
}

const leadsNowhere = () => undefined;

/** Every place, grouped as the menu groups it. */
export function directorySections(
  app: ShownApp,
  hrefOf: (target: BoundAppTarget) => string | undefined = shell().slots.navTargets?.hrefs(app, state.schema as DatabaseSchema | null) ??
    leadsNowhere,
): DirectorySection[] {
  const menu = appMenu(app, hrefOf);
  const sections: DirectorySection[] = [];
  const top: DirectoryLine[] = [];
  for (const node of menu) {
    if (node.kind === 'group') {
      const lines = linesOf(node);
      if (lines.length) sections.push({ label: node.label, lines });
    } else top.push(...linesOf(node));
  }
  if (top.length) sections.unshift({ lines: top });
  /* A room nav does not name is still a place: the home of an App with no nav, a list only a link reaches. */
  const named = new Set(sections.flatMap((section) => section.lines.map((line) => line.key)));
  const rest = appRooms(app)
    .filter((room) => !('error' in room && room.error) && !named.has(`room:${room.id}`))
    .map((room) => lineOf(room as MenuEntry));
  if (rest.length) sections.push({ label: say('more'), lines: rest });
  const made = newPaletteItems(app).map((item, at): DirectoryLine => ({
    key: `new:${at}:${item.label}`,
    label: item.label,
    kind: 'new',
    ...(item.icon ? { icon: item.icon } : {}),
    open: item.run,
  }));
  if (made.length) sections.push({ label: say('new'), lines: made });
  return sections;
}

/**
 * The sections a typed word keeps, each line scored by the palette's matcher on its name and, at half weight, on its
 * group's ("billing" finds the Billing group's rows): best first within a section, the menu's order otherwise.
 */
export function filterDirectory(sections: readonly DirectorySection[], query: string): DirectorySection[] {
  const asked = query.trim();
  if (!asked) return [...sections];
  return sections.flatMap((section) => {
    const lines = section.lines
      .map((line, at) => ({ line, at, points: Math.max(score(line.label, asked), section.label ? score(section.label, asked) / 2 : 0) }))
      .filter((scored) => scored.points > 0)
      .sort((a, b) => b.points - a.points || a.at - b.at)
      .map((scored) => scored.line);
    return lines.length ? [{ ...section, lines }] : [];
  });
}
