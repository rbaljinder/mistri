/**
 * The mark in front of a menu entry: its icon, or in the icon rail, a stand-in.
 *
 * An entry's icon is the one its view (or group) declares, drawn wherever the
 * entry is — the sidebar, the top bar, their menus. An App that declares
 * none looks exactly as it did: nothing is drawn beside its words. Only the
 * icon rail (`ui.shell.rail`), where the words are hidden, needs a mark for
 * every entry, so in a railed menu an entry without an icon gets a stand-in —
 * a given glyph (the star for a favorite), else its label's first letter —
 * drawn with `nav-rail-only`, which the stylesheet shows only while the rail
 * is folded. Always decoration: the entry's words stay its accessible name.
 */
import { isAppIcon } from '@mistriwork/engine/shared/appIcons.js';
import { Icon, type IconName } from './Icon.js';

interface NavGlyphProps {
  /** The icon the view or group declares; a name the client does not know is treated as none. */
  icon?: string;
  label: string;
  /** The menu folds to a rail, so an entry without an icon needs a stand-in there. */
  railed?: boolean;
  /** The rail's stand-in when there is no icon, instead of the first letter. */
  rail?: IconName;
  /** A dot in the theme's series color (1–8) in the icon's place: a project or a label told apart at a glance. */
  color?: number;
}

export function NavGlyph({ icon, label, railed = false, rail, color }: NavGlyphProps) {
  if (color) return <span className={`nav-dot nav-dot-c${color}`} aria-hidden="true" />;
  if (isAppIcon(icon)) return <Icon name={icon} className="nav-icon" />;
  if (!railed) return null;
  if (rail) return <Icon name={rail} className="nav-icon nav-rail-only" />;
  const initial = [...label.trim()][0]?.toLocaleUpperCase() ?? '·';
  return (
    <span className="nav-initial nav-rail-only" aria-hidden="true">
      {initial}
    </span>
  );
}
