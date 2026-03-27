/** BDL row must have a real `date` matching the calendar selection (never treat null as “any day”). */
export function bdlRowMatchesCalendarDay(lg: { date?: unknown }, dayIso: string): boolean {
  const d = lg.date
  if (d == null || d === '') return false
  return String(d).slice(0, 10) === dayIso
}
