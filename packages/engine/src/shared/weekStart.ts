/**
 * Which weekday a week starts on in a reader's locale, read once and remembered. Shared by the server's date
 * buckets and the client's charts, so a `week` means the same seven days on both sides.
 */
const weekStarts = new Map<string, number>();
/**
 * The day a week starts on where an App is read: its `ui.locale`'s own first
 * day (Sunday in the US, Monday in most of the world), and Monday — ISO's —
 * where the App names no locale. Said as an ISO weekday, 1 (Monday) to 7
 * (Sunday), the number a `week` bucket's SQL takes (filter.ts).
 */
export function localeWeekStart(locale: string | undefined): number {
  if (!locale) return 1;
  /* Asked for every date a request reads, of the same few locales; building
     an Intl.Locale each time was measurable on a busy server. Bounded,
     because a locale can come from a person's own setting. */
  const known = weekStarts.get(locale);
  if (known !== undefined) return known;
  if (weekStarts.size >= 64) weekStarts.clear();
  const first = readWeekStart(locale);
  weekStarts.set(locale, first);
  return first;
}

function readWeekStart(locale: string): number {
  try {
    const tag = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = (tag.getWeekInfo?.() ?? tag.weekInfo)?.firstDay;
    return typeof first === 'number' && Number.isInteger(first) && first >= 1 && first <= 7 ? first : 1;
  } catch {
    return 1;
  }
}
