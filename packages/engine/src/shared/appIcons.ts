/**
 * The icons an App may name, and the check that an authored name is one.
 *
 * A menu entry's icon is a word in the manifest (`icon: 'kanban'`), never a
 * path or a component: a manifest is data, served to the browser and checked
 * by the server, and a word is what both sides can agree on. The words are
 * Phosphor's own names (https://phosphoricons.com, MIT, Phosphor Icons), so
 * an author can look one up there and see exactly what they will get; the
 * glyphs are drawn by `@phosphor-icons/react`, which the client already
 * depends on (packages/kit/src/client/components/Icon.tsx imports each one by itself).
 *
 * The set is curated rather than the whole pack of ~1,500: the icons business
 * Apps put in a menu — places, people, things, money, documents, time, state,
 * and a clinic's, a school's, a workshop's — and the marks a value or a change
 * wears (a display rule's `icons`, an activity feed's resources), and not the
 * glyphs neither has a use for. A glyph costs an App nothing it does not use:
 * the server sends the drawings of the icons an App names with its payload
 * (packages/mistri/src/server/app/iconPayload.ts), and the client bundles none of the set. So
 * the set grows by a word here and `node scripts/generate-icons.mjs`; the
 * tests keep this list, the JSON schema's `appIcon` enum, packages/mistri/schema/app.d.ts's
 * `AppIconName` and the generated glyphs the same.
 */

export const APP_ICONS = [
  // Places and structure
  'house',
  'tray',
  'list',
  'list-checks',
  'kanban',
  'table',
  'calendar',
  'calendar-check',
  'clock',
  'chart-bar',
  'chart-line',
  'chart-pie',
  'gauge',
  'target',
  'flag',
  // People and organizations
  'user',
  'users',
  'user-circle',
  'address-book',
  'handshake',
  'buildings',
  'storefront',
  'briefcase',
  // Things and logistics
  'package',
  'truck',
  'car',
  'shopping-cart',
  // Money
  'receipt',
  'currency-dollar',
  'credit-card',
  'wallet',
  'bank',
  // Documents
  'file',
  'file-text',
  'folder',
  'clipboard-text',
  'note',
  'archive',
  'tag',
  'ticket',
  'star',
  'bookmark-simple',
  // Communication
  'bell',
  'envelope',
  'chat-circle',
  'phone',
  'headset',
  'megaphone',
  'globe',
  'map-pin',
  // Tools and state
  'magnifying-glass',
  'gear',
  'sliders',
  'wrench',
  'bug',
  'shield-check',
  'lock',
  'key',
  'database',
  'stack',
  'lightning',
  'check-circle',
  'warning',
  'info',
  // Values: a priority's signal bars, a status's mark, what a change did
  'cell-signal-low',
  'cell-signal-medium',
  'cell-signal-high',
  'cell-signal-full',
  'fire',
  'hourglass',
  'circle-dashed',
  'x-circle',
  'plus-circle',
  'pencil-simple',
  'paper-plane-tilt',
  'arrows-left-right',
  'arrow-circle-down',
  'arrow-circle-up',
  // Devices: what a service catalog orders and an asset list holds
  'laptop',
  'monitor',
  'device-mobile',
  'printer',
  // Health and care: a clinic, a pharmacy, a lab
  'stethoscope',
  'heartbeat',
  'heart',
  'pill',
  'syringe',
  'first-aid-kit',
  'thermometer',
  'flask',
  'test-tube',
  'microscope',
  'bed',
  'hospital',
  'ambulance',
  'tooth',
  'eyeglasses',
  'wheelchair',
  'baby',
  'dna',
  'brain',
  'bandaids',
  'hand-heart',
  // Learning, land and buildings
  'graduation-cap',
  'book-open',
  'student',
  'chalkboard-teacher',
  'factory',
  'warehouse',
  'house-line',
  'plant',
  'leaf',
  'sun',
  'cloud',
  'drop',
  // Travel
  'airplane',
  'bicycle',
  'bus',
  'train',
  'boat',
  // Things, tools and records
  'hammer',
  'toolbox',
  'plug',
  'lightbulb',
  'cube',
  'camera',
  'image',
  'trophy',
  'gift',
  'coffee',
  'fork-knife',
  'shopping-bag',
  'basket',
  'barcode',
  'qr-code',
  'scales',
  'gavel',
  'certificate',
  'identification-card',
  'fingerprint',
  'eye',
  'link',
  'paperclip',
  'scissors',
  'palette',
  'code',
  'terminal',
  'users-three',
  'user-plus',
] as const;

export type AppIconName = (typeof APP_ICONS)[number];

const KNOWN: ReadonlySet<string> = new Set(APP_ICONS);

export const isAppIcon = (value: unknown): value is AppIconName => typeof value === 'string' && KNOWN.has(value);

/* Edit distance, for "did you mean": a typo is a letter or two away, and a
   near synonym usually shares its first word ("chart" → chart-bar). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

function nearest(name: string): string[] {
  const lower = name.toLowerCase();
  const stem = lower.split('-')[0];
  return APP_ICONS.map((icon) => ({ icon, d: icon.startsWith(stem) || icon.split('-').includes(stem) ? 0 : distance(lower, icon) }))
    .filter((each) => each.d <= 3)
    .sort((a, b) => a.d - b.d || a.icon.localeCompare(b.icon))
    .slice(0, 3)
    .map((each) => each.icon);
}

/** An authored `icon`: one of APP_ICONS, or refused with the closest names and where the rest are listed.
 * `key` is the key the author wrote it under — `ui.logo` takes an icon too, and a refusal naming "icon" sent people looking for a key they never wrote. */
export function parseIcon(value: unknown, at: string, key = 'icon'): AppIconName {
  if (isAppIcon(value)) return value;
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${at} has ${/^[aeiou]/.test(key) ? 'an' : 'a'} "${key}" that is not an icon's name.`);
  const near = nearest(value.trim());
  throw new Error(
    `${at} has "${key}": "${value}", which is not one of the App icons.` +
      `${near.length ? ` Did you mean ${near.map((each) => `"${each}"`).join(', ')}?` : ''} The icons: ${APP_ICONS.join(', ')}.`,
  );
}
