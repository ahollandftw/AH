/**
 * Derive the Eastern Time calendar date from a UTC timestamp string.
 * A West Coast game starting 7 PM PT ends near midnight UTC and can have a
 * start_time_utc on the *next* UTC day — but it belongs on the ET game date.
 */
function utcToETDateIso(utcStr: string): string | null {
  try {
    const d = new Date(new Date(utcStr).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    if (isNaN(d.getTime())) return null
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${dd}`
  } catch {
    return null
  }
}

/**
 * Returns true only if a bdl_games row actually belongs to `dayIso`.
 *
 * Priority:
 *  1. If start_time_utc is present, convert to ET and compare — this is the
 *     ground truth. The stored `date` field can be wrong when the sync ran on
 *     a different day than the game was played.
 *  2. Fall back to the stored `date` field (covers rows with no start time).
 */
export function bdlRowMatchesCalendarDay(
  lg: { date?: unknown; start_time_utc?: unknown },
  dayIso: string,
): boolean {
  const utc = lg.start_time_utc
  if (utc && typeof utc === 'string') {
    const etDate = utcToETDateIso(utc)
    if (etDate != null) return etDate === dayIso
  }
  const d = lg.date
  if (d == null || d === '') return false
  return String(d).slice(0, 10) === dayIso
}
