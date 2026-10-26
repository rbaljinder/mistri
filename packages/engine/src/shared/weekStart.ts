/**
 * The day a week starts on where an App is read: its `ui.locale`'s own first
 * day (Sunday in the US, Monday in most of the world), and Monday — ISO's —
 * where the App names no locale. Said as an ISO weekday, 1 (Monday) to 7
 * (Sunday), the number a `week` bucket's SQL takes (filter.ts).
 */
export function localeWeekStart(locale: string | undefined): number {
  if (!locale) return 1;
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
